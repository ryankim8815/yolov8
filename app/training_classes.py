"""Explicit class transfer plans and immutable, deduplicated training snapshots."""
import hashlib
import json
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, StrictInt

from .datasets import components, split_components, save_snapshot, verify_dataset
from .store import DomainError


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class RetainedClass(Input):
    source_class_id: StrictInt = Field(ge=0)
    class_uuid: str = Field(min_length=1,max_length=128)


class ClassSelection(Input):
    retained: list[RetainedClass] = Field(default_factory=list,max_length=1000)
    new_class_uuids: list[str] = Field(default_factory=list,max_length=1000)


def normalized(name):
    return name.strip().casefold()


def unique_groups(samples):
    # Resolve leakage groups before dropping duplicate copies: a repeated image
    # may connect two capture environments that must remain in the same split.
    result=[]
    for group in components(samples):
        seen=set();unique=[]
        for sample in group:
            key=(sample['sha256'],sample['class_id'],tuple(round(v,10) for v in sample['normalized_box']))
            if key not in seen:seen.add(key);unique.append(sample)
        result.append(unique)
    return result


def source_data(store, parent, dataset_id):
    identifiers = list(dict.fromkeys(i for i in (parent.get("dataset_id"),dataset_id) if i))
    datasets = [store.get("dataset",i) for i in identifiers]
    classes = {}
    samples = {}
    records = {s["id"]:s for s in store.list("sample")}
    for dataset in datasets:
        for cls in dataset["classes"]:
            previous = classes.get(cls["uuid"])
            if previous and previous["name"] != cls["name"]:
                raise DomainError("같은 클래스의 이름이 데이터셋마다 다릅니다. 라벨을 확인하고 새 데이터셋을 고정하세요.",422)
            classes[cls["uuid"]] = dict(uuid=cls["uuid"],name=cls["name"])
        for item in dataset["items"]:
            record = records.get(item["sample_id"])
            if not record:raise DomainError("기존 사진의 교시 정보를 찾을 수 없습니다.",422)
            identity = (item["class_uuid"],item["group_id"],item["sha256"],item["label_sha256"])
            previous = samples.get(item["sample_id"])
            # Labels use different numeric IDs across snapshots. Their boxes must agree,
            # while immutable image hash/class/group identify the same approved sample.
            if previous:
                if identity[:3] != previous["identity"][:3]:
                    raise DomainError("같은 사진의 클래스·환경·이미지 해시가 다릅니다.",422)
                continue
            root = Path(dataset["path"])
            samples[item["sample_id"]] = {**record,"id":item["sample_id"],"class_id":item["class_uuid"],
                "group_id":item["group_id"],"sha256":item["sha256"],"label_sha256":item["label_sha256"],
                "image":str(root/item["image"]),"label":str(root/item["label"]),"identity":identity}
    return datasets,list(classes.values()),list(samples.values())


def class_options(store,parent,dataset_id):
    datasets,classes,samples = source_data(store,parent,dataset_id)
    for cls in classes:
        selected = [s for s in samples if s["class_id"] == cls["uuid"]]
        groups = unique_groups(selected) if selected else []
        cls.update(available=sum(map(len,groups)),groups=len(groups))
    by_uuid = {c["uuid"]:c for c in classes}
    rows=[]
    for cls in parent["classes"]:
        match = by_uuid.get(cls.get("uuid"))
        matches = [c for c in classes if normalized(c["name"]) == normalized(cls["name"])]
        if match is None and len(matches)==1:match=matches[0]
        rows.append(dict(id=cls["id"],name=cls["name"],suggested_uuid=match["uuid"] if match else None))
    return dict(initial_model_id=parent["id"],base_classes=rows,data_classes=classes,
                source_datasets=[dict(id=d["id"],counts=d["counts"],reused=d["id"]==parent.get("dataset_id")) for d in datasets])


def resolve_plan(store,parent,dataset_id,selection):
    selection=ClassSelection.model_validate(selection).model_dump()
    datasets,available,samples=source_data(store,parent,dataset_id)
    base={c["id"]:c for c in parent["classes"]};pool={c["uuid"]:c for c in available}
    rows=[];source_ids=[];uuids=[]
    for item in sorted(selection["retained"],key=lambda item:item["source_class_id"]):
        source=base.get(item["source_class_id"]);target=pool.get(item["class_uuid"])
        if not source or not target:raise DomainError("기반 클래스와 연결할 사진 라벨을 다시 선택하세요.",422)
        source_ids.append(source["id"]);uuids.append(target["uuid"])
        rows.append(dict(**target,source_class_id=source["id"],source_name=source["name"]))
    for identifier in selection["new_class_uuids"]:
        target=pool.get(identifier)
        if target is None:raise DomainError("선택한 데이터셋에 없는 새 클래스입니다.",422)
        uuids.append(identifier);rows.append(dict(**target,source_class_id=None,source_name=None))
    if len(source_ids)!=len(set(source_ids)) or len(uuids)!=len(set(uuids)):
        raise DomainError("기반 클래스나 사진 라벨을 중복 연결할 수 없습니다.",422)
    if len({normalized(row["name"]) for row in rows})!=len(rows):
        raise DomainError("최종 클래스 이름이 중복됩니다. 사진 라벨을 구분하세요.",422)
    errors=[]
    if not rows:errors.append("최종 인식 클래스를 한 개 이상 선택하세요.")
    selected=[s for s in samples if s["class_id"] in uuids]
    groups=unique_groups(selected) if selected else []
    selected=[sample for group in groups for sample in group]
    assigned=[]
    if selected:
        try:assigned=split_components(groups)
        except DomainError as error:errors.append(str(error))
    for index,row in enumerate(rows):
        row.update(id=index,train=sum(s["class_id"]==row["uuid"] and split=="train" for s,split in assigned),
                   val=sum(s["class_id"]==row["uuid"] and split=="val" for s,split in assigned),
                   available=sum(s["class_id"]==row["uuid"] for s in selected),
                   groups=sum(any(s["class_id"]==row["uuid"] for s in group) for group in groups))
        if row["groups"]<2:errors.append(f"{row['name']}: 독립 촬영 환경 자료가 부족합니다 ({row['available']}장 · {row['groups']}개 독립 그룹).")
        if assigned and (not row["train"] or not row["val"]):errors.append(f"{row['name']}: 학습·검증 자료가 모두 필요합니다.")
    public=dict(initial_model_id=parent["id"],initial_sha256=parent["formats"]["chrome"]["sha256"],
        input_dataset_id=dataset_id,source_datasets=[dict(id=d["id"],manifest_sha256=d["manifest_sha256"],yaml_sha256=d["yaml_sha256"]) for d in datasets],
        selection=selection,classes=rows,counts={split:sum(s==split for _,s in assigned) for split in ("train","val")},
        ready=not errors,errors=list(dict.fromkeys(errors)))
    identity=dict(plan=public,samples=[(s["id"],s["class_id"],s["group_id"],s["sha256"],s["label_sha256"],split) for s,split in assigned])
    public["signature"]=hashlib.sha256(json.dumps(identity,sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    return public,datasets,assigned


def freeze_plan(store,resolved):
    plan,datasets,assigned=resolved
    if not plan["ready"]:raise DomainError(" ".join(plan["errors"]),422)
    for dataset in datasets:verify_dataset(dataset)
    for sample,_ in assigned:
        lines=Path(sample["label"]).read_text().splitlines()
        if len(lines)!=1 or len(lines[0].split())!=5:raise DomainError("선택 학습 자료의 단일 객체 라벨을 확인하세요.",422)
        sample["normalized_box"]=[float(value) for value in lines[0].split()[1:]]
    mapping=[dict(id=row["id"],uuid=row["uuid"],name=row["name"]) for row in plan["classes"]]
    return save_snapshot(store,mapping,assigned,"ready","selected classes; reused frozen samples deduplicated; environment + sha256 + dHash independent split")
