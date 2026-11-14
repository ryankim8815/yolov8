"""Chrome owns the model sessions. The server owns frames, snapshots and model publication."""

import asyncio
import json
import math
import time
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from .chrome_model import validate_weights
from .store import DomainError, now

router = APIRouter(prefix="/api/chrome")


def local_socket(ws):
    origin = urlsplit(ws.headers.get("origin", ""))
    return origin.scheme in {"http", "https"} and origin.netloc == ws.headers.get(
        "host"
    )


def snapshot(rt, identifier):
    if rt.active_job != identifier:
        raise DomainError("Chrome 학습 작업이 종료되었습니다.", 409)
    return rt.store.get("job", identifier)


@router.get("/models/{identifier}")
def model_bytes(identifier: str, request: Request):
    rt = request.app.state.pipeline
    if rt.settings.backend != "chrome":
        raise DomainError("Chrome 실행 모드가 아닙니다.", 404)
    fmt = rt.registry.get(identifier)["formats"]["chrome"]
    if fmt["state"] != "ready" or not Path(fmt["path"]).is_file():
        raise DomainError("Chrome 모델이 준비되지 않았습니다.", 404)
    return FileResponse(fmt["path"], media_type="application/octet-stream")


@router.get("/jobs/{identifier}/template")
def template(identifier: str, request: Request):
    job = snapshot(request.app.state.pipeline, identifier)
    return FileResponse(
        Path(job["directory"]) / "template.onnx", media_type="application/octet-stream"
    )


@router.get("/jobs/{identifier}/images/{index}")
def training_image(identifier: str, index: int, request: Request):
    job = snapshot(request.app.state.pipeline, identifier)
    ds = job["dataset"]
    if not 0 <= index < len(ds["items"]):
        raise DomainError("학습 이미지가 없습니다.", 404)
    return FileResponse(
        Path(ds["path"]) / ds["items"][index]["image"], media_type="image/jpeg"
    )


def check_boxes(objects, names, width, height, maximum):
    if not isinstance(objects, list) or len(objects) > maximum:
        raise ValueError("잘못된 탐지 개수")
    checked = []
    for obj in objects:
        index, score, box = obj["class_id"], obj["confidence"], obj["xyxy"]
        if (
            type(index) is not int
            or index not in names
            or not isinstance(score, (float, int))
            or not math.isfinite(score)
            or not 0 <= score <= 1
            or len(box) != 4
            or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in box)
        ):
            raise ValueError("잘못된 탐지 결과")
        x1, y1, x2, y2 = box
        if not (0 <= x1 <= x2 <= width and 0 <= y1 <= y2 <= height):
            raise ValueError("탐지 좌표가 프레임 범위를 벗어났습니다.")
        checked.append(
            dict(class_id=index, label=names[index], confidence=score, xyxy=box)
        )
    return checked


async def receive(ws, timeout=30):
    message = await asyncio.wait_for(ws.receive_json(), timeout)
    if message.get("error"):
        raise ValueError(str(message["error"])[:500])
    return message


async def idle(ws):
    await ws.send_json({"action": "idle"})
    await receive(ws, 5)
    await asyncio.sleep(0.15)


@router.websocket("/inference")
async def inference(ws: WebSocket):
    rt = ws.app.state.pipeline
    if (
        not local_socket(ws)
        or rt.settings.backend != "chrome"
        or getattr(rt, "chrome_owner", None)
    ):
        await ws.close(code=1008)
        return
    rt.chrome_owner = ws
    pipe = None
    try:
        await ws.accept()
        while not rt.stop_event.is_set():
            current = rt.pipeline
            if (
                not current
                or current.stop_event.is_set()
                or current.fatal_error
                or rt.active_job
            ):
                await idle(ws)
                continue
            if current is not pipe:
                pipe = current
                names = {c["id"]: c["name"] for c in pipe.chrome_classes}
                fmt = rt.registry.get(pipe.model_version)["formats"]["chrome"]
                await ws.send_json(
                    dict(
                        action="load",
                        url=f"/api/chrome/models/{pipe.model_version}",
                        hash=fmt["sha256"],
                        names=names,
                        settings=dict(
                            imgsz=pipe.settings.imgsz,
                            confidence=pipe.settings.confidence,
                            iou=pipe.settings.iou,
                            max_det=pipe.settings.max_det,
                        ),
                    )
                )
                reply = await receive(ws, 85)
                if reply.get("loaded") != fmt["sha256"]:
                    raise ValueError("모델 로드 확인 실패")
                with pipe.lock:
                    pipe.model_ready = True
                    pipe.mode_note = None
                    pipe.detector_metadata = {
                        "backend": "chrome",
                        "runtime": "onnxruntime-web/webgpu",
                    }
            packet = await asyncio.to_thread(pipe.input_slot.take, 0.15)
            if packet is None:
                await idle(ws)
                continue
            import cv2

            ok, jpeg = await asyncio.to_thread(
                cv2.imencode, ".jpg", packet.frame, [cv2.IMWRITE_JPEG_QUALITY, 92]
            )
            if not ok:
                continue
            start = time.monotonic_ns()
            await ws.send_json(
                dict(
                    action="predict", frame_id=packet.frame_id, session=pipe.session_id
                )
            )
            await ws.send_bytes(jpeg.tobytes())
            reply = await receive(ws)
            finished = time.monotonic_ns()
            if (
                rt.pipeline is not pipe
                or pipe.stop_event.is_set()
                or rt.busy
                or finished - packet.captured_ns > pipe.settings.stale_seconds * 1e9
            ):
                continue
            if (
                reply.get("session") != pipe.session_id
                or reply.get("frame_id") != packet.frame_id
            ):
                raise ValueError("프레임이 일치하지 않습니다.")
            h, w = packet.frame.shape[:2]
            objects = check_boxes(reply["objects"], names, w, h, pipe.settings.max_det)
            await asyncio.to_thread(
                pipe.publish_detection, packet, objects, start, finished, "chrome"
            )
    except (
        WebSocketDisconnect,
        OSError,
        RuntimeError,
        TimeoutError,
        ValueError,
        KeyError,
        TypeError,
    ) as exc:
        if pipe and not isinstance(exc, WebSocketDisconnect):
            with pipe.lock:
                pipe.mode_note = str(exc)[:500]
    finally:
        rt.chrome_owner = None
        if pipe:
            with pipe.lock:
                pipe.model_ready = False
                pipe.result = None
                pipe.result_generation = None
                pipe.sensor_history.clear()
                pipe.preview_history.clear()
        try:
            await ws.close()
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass


def job_config(job):
    directory = Path(job["directory"])
    cfg = json.loads((directory / "template.json").read_text())
    ds = job["dataset"]
    cfg.update(
        train=[],
        val=[],
        epochs=job["epochs"],
        batch=job["batch"],
        patience=job["patience"],
        names={c["id"]: c["name"] for c in ds["classes"]},
        url=f"/api/chrome/jobs/{job['id']}/template",
    )
    for index, item in enumerate(ds["items"]):
        label = (Path(ds["path"]) / item["label"]).read_text()
        cfg[item["split"]].append(
            dict(
                url=f"/api/chrome/jobs/{job['id']}/images/{index}",
                labels=[
                    [float(x) for x in row.split()]
                    for row in label.splitlines()
                    if row.strip()
                ],
            )
        )
    return cfg


def publish(rt, job, cfg, weights, metrics):
    import hashlib

    directory = Path(job["directory"])
    validate_weights((directory / "template.onnx").read_bytes(), weights, cfg["params"])
    if (
        not all(math.isfinite(metrics[k]) for k in ("train_loss", "val_loss"))
        or not 1 <= metrics["epoch"] <= job["epochs"]
    ):
        raise ValueError("검증 결과를 확인할 수 없습니다.")
    digest = hashlib.sha256(weights).hexdigest()
    if metrics.get("verified_hash") != digest:
        raise ValueError("Chrome 추론에서 검증한 가중치와 다릅니다.")
    with rt.lock:
        snapshot(rt, job["id"])
        path = directory / "best.onnx"
        temp = directory / "best.onnx.tmp"
        temp.write_bytes(weights)
        temp.replace(path)
        fmt = dict(
            state="ready",
            path=str(path),
            sha256=digest,
            metrics=metrics,
            source_sha256=job["initial_sha256"],
        )
        record = dict(
            id=job["model_id"],
            name="사용자 모델 · " + job["created_at"][:19],
            kind="custom",
            created_at=now(),
            classes=job["dataset"]["classes"],
            dataset_id=job["dataset_id"],
            job_id=job["id"],
            initial_sha256=job["initial_sha256"],
            initial_model_id=job.get("initial_model_id"),
            training=dict(
                class_plan=job.get("class_plan"),
                actual=dict(
                    imgsz=cfg["size"],
                    epochs=job["epochs"],
                    batch=job["batch"],
                    patience=job["patience"],
                    optimizer="Adam",
                    lr0=0.0001,
                ),
            ),
            environment=dict(backend="Chrome WebGPU"),
            formats={"chrome": fmt},
        )
        rt.registry.publish(
            record,
            {**job, "state": "completed", "ended_at": now(), "progress": metrics},
        )
        rt.active_job = rt.busy = None


@router.websocket("/jobs/{identifier}")
async def training(ws: WebSocket, identifier: str):
    rt = ws.app.state.pipeline
    owner = getattr(rt, "chrome_trainer", None)
    if (
        not local_socket(ws)
        or rt.active_job != identifier
        or (owner is not None and owner.path_params.get("identifier") == identifier)
    ):
        await ws.close(code=1008)
        return
    rt.chrome_trainer = ws
    try:
        await ws.accept()
        job = snapshot(rt, identifier)
        cfg = await asyncio.to_thread(job_config, job)
        rt.store.update("job", identifier, state="training")
        await ws.send_json(cfg)
        while True:
            message = await receive(ws, 120)
            snapshot(rt, identifier)
            if message.get("done"):
                weights = await asyncio.wait_for(ws.receive_bytes(), 30)
                await asyncio.to_thread(
                    publish, rt, job, cfg, weights, message["metrics"]
                )
                await ws.send_json({"published": job["model_id"]})
                break
            progress = message["progress"]
            rt.store.update("job", identifier, progress=progress)
            if "train_loss" in progress and "stage" not in progress:
                with (Path(job["directory"]) / "train.log").open("a") as stream:
                    stream.write(json.dumps(progress, ensure_ascii=False) + "\n")
            await ws.send_json({"continue": True})
    except Exception as exc:
        rt.finish_chrome_job(
            identifier, "failed", str(exc)[:500] or "학습 탭 연결이 종료되었습니다."
        )
        try:
            await ws.send_json({"error": str(exc)[:500]})
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
    finally:
        if rt.chrome_trainer is ws:
            rt.chrome_trainer = None
        try:
            await ws.close()
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
