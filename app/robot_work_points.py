"""Named packing locations in the E0509 BASE frame (XYZ mm, ABC degrees)."""
import json
from typing import Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat

from .store import DomainError, atomic_json, now

PointName = Literal["box", "shipping_label"]


class WorkPointInput(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    pose: list[FiniteFloat] = Field(min_length=6, max_length=6)
    revision: str | None = Field(max_length=32)


class WorkPoints:
    def __init__(self, path):
        self.path = path
        self.points = json.loads(path.read_text()) if path.exists() else {
            name: dict(pose=None, revision=None, updated_at=None) for name in ("box", "shipping_label")}

    def save(self, name, body):
        if self.points[name]["revision"] != body.revision:
            raise DomainError("다른 화면에서 이 좌표를 변경했습니다. 저장값을 다시 불러오세요.")
        point = dict(pose=body.pose, revision=uuid4().hex, updated_at=now())
        updated = {**self.points, name: point}
        atomic_json(self.path, updated)
        self.points = updated
        return point
