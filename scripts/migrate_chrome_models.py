"""One-time, CPU-only conversion of registered legacy YOLOv8n checkpoints to Chrome ONNX."""

import argparse
import json
import tempfile
from pathlib import Path

from app.config import Settings
from app.store import Store
from scripts.common import digest


def main():
    import onnx
    from ultralytics import YOLO

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, default=Settings.from_env().state_dir)
    args = parser.parse_args()
    if not (args.state / "metadata.sqlite3").is_file():
        parser.error("기존 모델 레지스트리가 없습니다.")
    store = Store(args.state)
    try:
        for model in store.list("model"):
            fmt = model["formats"].get("mps", {})
            if (
                model.get("deleted_at")
                or model["kind"] != "custom"
                or fmt.get("state") != "ready"
            ):
                continue
            path = Path(fmt["path"])
            if digest(path) != fmt["sha256"]:
                raise ValueError(f"{path}: 등록된 PT 해시와 다릅니다.")
            prior = model["formats"].get("chrome")
            if (
                prior
                and prior.get("source_sha256") == fmt["sha256"]
                and Path(prior.get("path", "")).is_file()
                and digest(prior["path"]) == prior["sha256"]
            ):
                continue
            dest = store.root / "chrome-models" / model["id"]
            dest.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=dest) as work:
                import shutil

                src = Path(work) / "model.pt"
                shutil.copyfile(path, src)
                yolo = YOLO(str(src), task="detect")
                if yolo.names != {c["id"]: c["name"] for c in model["classes"]}:
                    raise ValueError("클래스 매핑이 다릅니다.")
                out = Path(
                    yolo.export(
                        format="onnx",
                        imgsz=640,
                        batch=1,
                        device="cpu",
                        dynamic=False,
                        opset=17,
                        simplify=False,
                        nms=False,
                    )
                )
                onnx.checker.check_model(str(out))
                sha = digest(out)
                target = dest / (sha + ".onnx")
                out.replace(target)
            with store.write_transaction() as write:
                latest = store.get("model", model["id"])
                if (
                    latest.get("deleted_at")
                    or latest["formats"]["mps"]["sha256"] != fmt["sha256"]
                ):
                    raise ValueError("기반 모델이 변경되었습니다.")
                latest["formats"]["chrome"] = dict(
                    state="ready",
                    path=str(target),
                    sha256=sha,
                    source_sha256=fmt["sha256"],
                )
                write("model", latest)
            print("Chrome 모델 등록:", model["id"], flush=True)
    finally:
        store.close()


if __name__ == "__main__":
    main()
