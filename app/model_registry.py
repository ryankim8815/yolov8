"""Display metadata and immutable version lineage for locally registered weights."""
import json

from pathlib import Path


from .config import ROOT
from .packing import Packing
from .store import DomainError, atomic_json, now

BUILTIN = "coco-yolov8n"


def coco_classes():
    # The bundled ONNX uses this COCO class order.
    names = {int(i): name for i,name in json.loads((ROOT / "app/chrome/coco.json").read_text()).items()}
    return [{"id": index, "name": name} for index, name in sorted(names.items())]


def json_report(path):
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def attach_benchmarks(formats):
    dataset = json_report(ROOT / "models/manifest.json").get("dataset", {})
    if dataset.get("name") != "COCO128" or not dataset.get("sha256"):
        return
    for backend, fmt in formats.items():
        for mode, key in (("accuracy", "metrics"), ("latency", "latency")):
            report = json_report(ROOT / "artifacts" / f"{backend}-{mode}.json")
            if (isinstance(report.get("results"), dict)
                    and report.get("backend") == backend and report.get("mode") == mode
                    and report.get("dataset_sha256") == dataset["sha256"]
                    and report.get("model_sha256") == fmt["sha256"]):
                fmt[key] = report["results"]
                fmt["evaluation_dataset"] = "COCO128"


class ModelRegistry:
    def __init__(self, store, chrome_only=False):
        self.store = store
        self.chrome_only = chrome_only

    def _view(self, model):
        if not self.chrome_only:
            return {**model, "formats": {k: v for k, v in model.get("formats", {}).items() if k in {"chrome", "cpu"}}}
        fmt = model.get("formats", {}).get("chrome", {})
        if Path(fmt.get("path") or "").suffix.lower() != ".onnx":
            return None
        if fmt.get("state") == "ready" and not fmt.get("sha256"):
            fmt = {**fmt, "state": "unavailable"}
        return {**model, "formats": {"chrome": fmt}}

    def models(self):
        with self.store.lock:
            names = {a["model_id"]: a["name"] for a in self.store.list("model_alias")}
            records = self.store.list("model")
            deleted = {m["id"]: names.get(m["id"], m.get("name", m["id"]))
                       for m in records if m.get("deleted_at")}
            result = []
            for record in records:
                model = self._view(record)
                if model is None or model.get("deleted_at"):
                    continue
                model["name"] = names.get(model["id"], model.get("name", model["id"]))
                if model.get("parent_model_id") in deleted:
                    model["deleted_parent_name"] = deleted[model["parent_model_id"]]
                result.append(model)
            return result

    def get(self,identifier):
        model=self.store.get('model',identifier)
        if model.get('deleted_at'):raise DomainError('삭제된 모델입니다.',404)
        model = self._view(model)
        if model is None:
            raise DomainError("Chrome에 등록된 ONNX 모델이 없습니다.", 404)
        return model

    def delete(self,identifier,expected_name):
        with self.store.write_transaction() as write:
            model=self.get(identifier)
            if identifier==BUILTIN or model.get('kind')=='builtin':raise DomainError('기본 모델은 삭제할 수 없습니다.')
            alias=self.store.db.execute('SELECT name FROM model_aliases WHERE model_id=(SELECT id FROM models WHERE public_id=?)',(identifier,)).fetchone()
            name=alias[0] if alias else model.get('name') or identifier
            if expected_name!=name:raise DomainError('모델 이름이 변경되었습니다. 목록을 새로 불러온 뒤 삭제할 모델을 다시 확인하세요.',412)
            write('model',{**self.store.get('model', identifier),'deleted_at':now()})
            self.store.db.execute('DELETE FROM active_models WHERE model_id=(SELECT id FROM models WHERE public_id=?)',(identifier,))
            Packing.log(write,'모델',f'{name} · 모델 삭제 · {identifier}')
        return {'id':identifier,'deleted':True}

    def rename(self, identifier, name):
        name = name.strip()
        if not 1 <= len(name) <= 80 or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise DomainError("이름은 제어 문자 없이 1~80자로 입력하세요", 422)
        with self.store.write_transaction() as write:
            model = self.get(identifier)
            alias = self.store.db.execute("SELECT name FROM model_aliases WHERE model_id="
                                          "(SELECT id FROM models WHERE public_id=?)", (identifier,)).fetchone()
            old = alias[0] if alias else model.get("name") or identifier
            write("model_alias", {"id": "alias-" + identifier, "model_id": identifier, "name": name})
            if old != name:
                Packing.log(write, "모델", f"{old} → {name} · 모델 이름 변경")
        return {**model, "name": name}

    @staticmethod
    def _lineage(model, parent_id, models):
        if parent_id == BUILTIN:
            return {"parent_model_id": BUILTIN, "family_id": model["id"], "version_number": 1}
        parent = models.get(parent_id, {})
        family = parent.get("family_id")
        if family:
            latest = max(m["version_number"] for m in models.values() if m.get("family_id") == family)
            return {"parent_model_id": parent_id, "family_id": family, "version_number": latest + 1}
        return {"parent_model_id": parent_id, "family_id": None, "version_number": None}

    @staticmethod
    def _legacy_parent(model, job, models):
        digest = model.get("initial_sha256")
        if not digest or digest != job.get("initial_sha256") or job.get("model_id") != model["id"]:
            return None
        if model.get("initial_model_id") != job.get("initial_model_id"):
            return None
        parent_id = job.get("initial_model_id") or BUILTIN
        parent = models.get(parent_id, {})
        if any(fmt.get("sha256") == digest for fmt in parent.get("formats", {}).values()):
            return parent_id
        return None

    def recover_versions(self):
        """Recover proven ancestry in parent order; leave incomplete records unnumbered."""
        with self.store.write_transaction() as write:
            models = {m["id"]: m for m in self.store.list("model")}
            pending = {i: m for i, m in models.items() if m.get("kind") == "custom" and not m.get("version_number")}
            if not pending:
                return
            # Load only referenced jobs; they carry the dataset counts at training time.
            parents = {}
            for identifier, model in pending.items():
                try:
                    job = self.store.get("job", model.get("job_id"))
                except DomainError:
                    job = {}
                parents[identifier] = self._legacy_parent(model, job, models)
                counts = job.get("dataset", {}).get("counts")
                if counts and model.get("dataset_counts") != counts:
                    model["dataset_counts"] = counts
                    write("model", model)
            while pending:
                resolved = [i for i in pending if parents[i] not in pending]
                if not resolved:  # Corrupted/cyclic links cannot establish a version.
                    break
                for identifier in resolved:
                    model = pending.pop(identifier)
                    lineage = self._lineage(model, parents[identifier], models)
                    if any(model.get(k) != v for k, v in lineage.items()):
                        model.update(lineage)
                        write("model", model)

    def publish(self, model, job):
        """Allocate a number only when the successful training result is committed."""
        with self.store.write_transaction() as write:
            models = {m["id"]: m for m in self.store.list("model")}
            if model["id"] in models:
                return  # Replaying a completed publication never consumes a number.
            parent_id = job.get("initial_model_id") or BUILTIN
            model.update(self._lineage(model, parent_id, models))
            model["dataset_counts"] = job["dataset"]["counts"]
            write("job", job)
            write("model", model)
            atomic_json(Path(job["directory"]) / "model.json", model)
