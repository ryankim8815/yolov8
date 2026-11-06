"""Small, transactional metadata repository. User-facing names never become paths."""
import hashlib
import json
import os
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path


def now():
    return datetime.now(timezone.utc).isoformat()


def uid(prefix):
    return f"{prefix}-{uuid.uuid4().hex}"


def sha256(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with temp.open("w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.flush()
        os.fsync(stream.fileno())
    temp.replace(path)


class DomainError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.db = sqlite3.connect(self.root / "metadata.sqlite3", check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.execute("CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT PRIMARY KEY, data TEXT NOT NULL)")
        self.db.execute("CREATE INDEX IF NOT EXISTS records_kind ON records(kind)")
        self.db.commit()

    def put_many(self, records):
        with self.lock, self.db:
            for kind, value in records:
                self.db.execute("INSERT INTO records VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                                (kind, value["id"], json.dumps(value, ensure_ascii=False, allow_nan=False)))

    def put(self, kind, value):
        self.put_many([(kind, value)])
        return value

    def get(self, kind, identifier):
        with self.lock:
            row = self.db.execute("SELECT data FROM records WHERE kind=? AND id=?", (kind, identifier)).fetchone()
        if row is None:
            raise DomainError(f"{kind}: 항목을 찾을 수 없습니다", 404)
        return json.loads(row[0])

    def list(self, kind):
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute("SELECT data FROM records WHERE kind=? ORDER BY rowid", (kind,))]

    def update(self, kind, identifier, **changes):
        with self.lock:
            value = self.get(kind, identifier)
            value.update(changes)
            return self.put(kind, value)

    def named(self, kind, name):
        name = name.strip()
        if not name or len(name) > 80 or any(ord(c) < 32 or ord(c) == 127 for c in name):
            raise DomainError("이름은 제어 문자 없이 1~80자로 입력하세요", 422)
        with self.lock:
            if any(v["name"].casefold() == name.casefold() for v in self.list(kind)):
                raise DomainError("같은 이름이 있습니다. 기존 항목을 선택하세요")
            return self.put(kind, {"id": uid(kind), "name": name, "created_at": now()})

    def recover(self):
        for kind in ("collection", "job", "operation"):
            for value in self.list(kind):
                if value.get("state") in {"collecting", "stopping", "queued", "preparing", "training", "evaluating", "exporting", "running", "cancelling"}:
                    self.update(kind, value["id"], state="interrupted", error="서버 재시작으로 중단됨. 자동 재실행하지 않습니다.", ended_at=now())
        # Only DB-complete samples can be reviewed or exported. Remove interrupted pairs.
        known = {str((self.root / s[key]).resolve()) for s in self.list("sample") for key in ("image", "label")}
        directory = self.root / "collections"
        if directory.exists():
            for path in directory.rglob("*"):
                if (path.is_file() and re.fullmatch(r"sample-[0-9a-f]{32}\.(jpg|txt)(\.tmp)?", path.name)
                        and str(path.resolve()) not in known):
                    path.unlink()

    def close(self):
        with self.lock:
            self.db.close()
