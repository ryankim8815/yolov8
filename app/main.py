import asyncio
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.requests import ClientDisconnect

from .config import Settings
from .pipeline import Pipeline

STATIC = Path(__file__).parent / "static"
log = logging.getLogger(__name__)


class TimedStreamingResponse(StreamingResponse):
    """Bound each ASGI send, including backpressure after a client stops reading."""
    def __init__(self, content, timeout):
        super().__init__(content, media_type="multipart/x-mixed-replace; boundary=frame",
                         headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
        self.timeout = timeout

    async def __call__(self, scope, receive, send):
        async def timed_send(message):
            await asyncio.wait_for(send(message), timeout=self.timeout)
        try:
            await super().__call__(scope, receive, timed_send)
        except (TimeoutError, ClientDisconnect, OSError):
            log.info("MJPEG subscriber disconnected or exceeded send timeout")
        finally:
            await self.body_iterator.aclose()


async def jpeg_frames(pipeline):
    pipeline.subscribe_video(1)
    previous_id = None
    try:
        while not pipeline.stop_event.is_set():
            if pipeline.status()["ready"]:
                jpeg = pipeline.latest_jpeg()
                if jpeg is not None:
                    frame_id, captured_ns, data = jpeg
                    fresh = (time.monotonic_ns() - captured_ns) / 1e9 <= pipeline.settings.stale_seconds
                    if fresh and frame_id != previous_id:
                        previous_id = frame_id
                        header = (f"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {len(data)}\r\n"
                                  f"X-Frame-Id: {frame_id}\r\n\r\n").encode("ascii")
                        yield header + data + b"\r\n"
            await asyncio.sleep(0.03)
    finally:
        pipeline.subscribe_video(-1)


def create_app(settings=None, pipeline_factory=Pipeline):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(application):
        pipeline = pipeline_factory(settings)
        application.state.pipeline = pipeline
        pipeline.start()
        try:
            yield
        finally:
            await asyncio.to_thread(pipeline.stop)

    application = FastAPI(title="YOLOv8 Local Camera", version="0.1.0", lifespan=lifespan)
    application.mount("/static", StaticFiles(directory=STATIC), name="static")

    @application.get("/")
    async def index():
        return FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-store"})

    @application.get("/healthz")
    async def health():
        return {"status": "ok"}

    @application.get("/api/status")
    async def status():
        return JSONResponse(application.state.pipeline.status(), headers={"Cache-Control": "no-store"})

    @application.get("/readyz")
    async def ready():
        current = application.state.pipeline.status()
        return JSONResponse(current, status_code=200 if current["ready"] else 503,
                            headers={"Cache-Control": "no-store"})

    @application.get("/api/detections/latest")
    async def latest():
        pipeline = application.state.pipeline
        current = pipeline.status()
        result = pipeline.latest_result()
        if not current["ready"] or result is None:
            return JSONResponse({"error": current["state"], "status": current}, status_code=503,
                                headers={"Cache-Control": "no-store"})
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    @application.get("/stream.mjpg")
    async def stream():
        return TimedStreamingResponse(jpeg_frames(application.state.pipeline), settings.send_timeout)

    @application.websocket("/ws/detections")
    async def detections(websocket: WebSocket):
        await websocket.accept()
        pipeline = application.state.pipeline
        last_id = None
        last_state = None
        last_status_time = 0.0
        try:
            while not pipeline.stop_event.is_set():
                current = pipeline.status()
                if current["state"] != last_state or time.monotonic() - last_status_time >= 1:
                    await asyncio.wait_for(websocket.send_json(current), timeout=settings.send_timeout)
                    last_state = current["state"]
                    last_status_time = time.monotonic()
                if current["ready"]:
                    result = pipeline.latest_result()
                    if result and result["frame_id"] != last_id:
                        await asyncio.wait_for(websocket.send_json(result), timeout=settings.send_timeout)
                        last_id = result["frame_id"]
                await asyncio.sleep(0.03)
        except (WebSocketDisconnect, TimeoutError, OSError, RuntimeError):
            log.debug("WebSocket subscriber disconnected", exc_info=True)
        finally:
            try:
                await asyncio.wait_for(websocket.close(), timeout=settings.send_timeout)
            except (WebSocketDisconnect, TimeoutError, OSError, RuntimeError):
                pass

    return application


app = create_app()
