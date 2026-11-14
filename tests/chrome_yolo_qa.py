"""Hardware WebGPU integration fixture: real application, isolated state, recorded RGB frames."""

import tempfile
import time
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
import cv2
from app.config import ROOT, Settings
from app.main import create_app
from app.pipeline import Pipeline
from app.store import uid


def create_qa_app():
    selected = []
    for label in sorted((ROOT / "data/coco128/labels/train2017").glob("*.txt")):
        rows = label.read_text().splitlines()
        if len(rows) == 1:
            image = ROOT / "data/coco128/images/train2017" / (label.stem + ".jpg")
            selected.append((image, list(map(float, rows[0].split()))))
        if len(selected) == 10:
            break
    if len(selected) != 10:
        raise ValueError("COCO128 is required for this test")

    class Replay:
        def __init__(self, settings):
            self.frame = cv2.imread(str(selected[0][0]))

        def read(self):
            time.sleep(0.08)
            return self.frame

        def close(self):
            pass

    app = create_app(
        Settings.from_env(),
        lambda settings: Pipeline(settings, camera_factory=Replay),
        Path(tempfile.mkdtemp(prefix="chrome-yolo-qa-")),
    )
    original = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(app):
        async with original(app):
            rt = app.state.pipeline
            cls = rt.store.named("class", "테스트 상품")
            for index, (image, row) in enumerate(selected):
                frame = cv2.imread(str(image))
                h, w = frame.shape[:2]
                _, x, y, bw, bh = row
                group = rt.store.named("group", str(index))
                collection = rt.store.put(
                    "collection",
                    dict(
                        id=uid("collection"),
                        class_id=cls["id"],
                        group_id=group["id"],
                        model_id="coco-yolov8n",
                        model_hash="public",
                        state="stopped",
                        created_at="qa",
                    ),
                )
                box = [
                    max(0, (x - bw / 2) * w),
                    max(0, (y - bh / 2) * h),
                    min(w, (x + bw / 2) * w),
                    min(h, (y + bh / 2) * h),
                ]
                sample = rt.collector._write(
                    collection,
                    SimpleNamespace(frame=frame, frame_id=index, captured_at="qa"),
                    {"session_id": "qa"},
                    {"xyxy": box, "confidence": 1, "label": "test", "class_id": 0},
                )
                rt.store.update("sample", sample["id"], review="approved")
            rt.dataset()
            yield

    app.router.lifespan_context = lifespan
    return app
