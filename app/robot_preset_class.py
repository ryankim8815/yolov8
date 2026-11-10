"""Exact spoken class matching against one active model's catalog."""
import hashlib
import json

from .store import DomainError
from .voice_commands import normalized


def catalog_signature(catalog):
    classes=catalog.get("classes") or []
    if not catalog.get("model_version") or not classes:
        raise DomainError("현재 YOLO 모델의 클래스 목록을 불러올 수 없습니다.")
    if any(type(c.get("id")) is not int or c["id"]<0 or not isinstance(c.get("name"),str) or not normalized(c["name"]) for c in classes):
        raise DomainError("현재 YOLO 모델의 클래스 목록이 올바르지 않습니다.")
    if len({c["id"] for c in classes})!=len(classes):raise DomainError("YOLO 클래스 ID가 중복되었습니다.")
    value=[catalog["model_version"],sorted((c["id"],c["name"]) for c in classes)]
    return hashlib.sha256(json.dumps(value,ensure_ascii=False).encode()).hexdigest()


def match_class(catalog,text):
    catalog_signature(catalog)
    matches=[c for c in catalog["classes"] if normalized(c["name"])==normalized(text)]
    if len(matches)!=1:
        raise DomainError("현재 YOLO 모델의 클래스 이름 한 개만 말씀하세요. 목록에 없는 이름과 여러 클래스는 선택할 수 없습니다.")
    return matches[0]
