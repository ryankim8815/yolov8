"""Verify explicit source-row transfer before any optimizer step."""
from uuid import uuid4


def prepare_transfer(model,job):
    plan=job.get("class_plan")
    if not plan:return None
    rows=plan["classes"]
    expected={row["id"]:row["name"] for row in rows}
    if expected!={row["id"]:row["name"] for row in job["dataset"]["classes"]}:
        raise ValueError("최종 클래스와 학습 스냅샷이 다릅니다.")
    source=model.model
    names=dict(source.names)
    retained=[row for row in rows if row["source_class_id"] is not None]
    for row in retained:
        if names.get(row["source_class_id"])!=row["source_name"]:
            raise ValueError("기반 체크포인트의 클래스 이름·ID가 등록값과 다릅니다.")
    by_source={row["source_class_id"]:row for row in retained}
    prefix="__excluded_"+uuid4().hex+"_"
    source.names={index:by_source[index]["name"] if index in by_source else prefix+str(index) for index in names}
    branches=source.model[-1].cv3
    if not retained:
        for branch in branches:branch[-1].reset_parameters()
    copied=[(row["id"],[(branch[-1].weight[row["source_class_id"]].detach().cpu().clone(),
                         branch[-1].bias[row["source_class_id"]].detach().cpu().clone()) for branch in branches]) for row in retained]
    return dict(names=expected,rows=copied)


def verify_transfer(trainer,expected):
    if expected is None:return
    import torch
    model=trainer.model
    if model.names!=expected["names"]:raise ValueError("학습 모델의 최종 클래스 순서가 다릅니다.")
    branches=model.model[-1].cv3
    for identifier,weights in expected["rows"]:
        if len(weights)!=len(branches):raise ValueError("기반 모델과 출력 구조가 다릅니다.")
        for branch,(weight,bias) in zip(branches,weights):
            if not torch.equal(branch[-1].weight[identifier].detach().cpu(),weight) or not torch.equal(branch[-1].bias[identifier].detach().cpu(),bias):
                raise ValueError("선택한 기반 클래스의 가중치 이전을 확인할 수 없습니다. 학습을 중단합니다.")
