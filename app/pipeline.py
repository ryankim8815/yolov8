import logging
import os
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone

from .buffers import LatestSlot
from .capture import OpenCVCamera
from .detector import Detector
from .render import encode_jpeg

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class FramePacket:
    frame_id: int
    generation: int
    captured_ns: int
    captured_at: str
    frame: object


def percentile(values, fraction):
    if not values:
        return None
    ordered = sorted(values)
    pos = (len(ordered) - 1) * fraction
    lower = int(pos)
    upper = min(lower + 1, len(ordered) - 1)
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (pos - lower), 3)


class Pipeline:
    def __init__(self, settings, camera_factory=OpenCVCamera, detector_factory=Detector,
                 encoder=encode_jpeg, retry_delays=(1, 2, 4, 8, 10)):
        self.settings = settings
        self.camera_factory, self.detector_factory, self.encoder = camera_factory, detector_factory, encoder
        self.retry_delays = retry_delays
        self.session_id = uuid.uuid4().hex
        self.stop_event = threading.Event()
        self.input_slot, self.preview_slot = LatestSlot(), LatestSlot()
        self.lock = threading.Lock()
        self.started_at = time.monotonic()
        self.threads = []
        self.model_ready = False
        self.camera_online = False
        self.generation = 0
        self.camera_size = None
        self.camera_error = None
        self.fatal_error = None
        self.result = None
        self.result_ns = None
        self.result_generation = None
        self.jpeg = None
        self.subscribers = 0
        self.detector_metadata = {}
        self.counts = {"captured": 0, "detected": 0, "encoded": 0}
        self.events = {key: deque(maxlen=2048) for key in self.counts}
        self.latencies = deque(maxlen=1000)

    def start(self):
        if self.threads:
            raise RuntimeError("Pipeline cannot be started twice")
        for name, target in (("capture", self._capture), ("inference", self._inference), ("encoder", self._encode)):
            thread = threading.Thread(target=target, name=f"yolo-{name}", daemon=True)
            self.threads.append(thread)
            thread.start()

    def stop(self):
        self.stop_event.set()
        self.input_slot.close()
        self.preview_slot.close()
        deadline = time.monotonic() + 5
        for thread in self.threads:
            thread.join(timeout=max(0, deadline - time.monotonic()))
        alive = [thread.name for thread in self.threads if thread.is_alive()]
        if alive:
            log.error("Native worker did not stop within 5 seconds; restart the process: %s", alive)
        with self.lock:
            self.jpeg = None

    def _count(self, name):
        # Caller holds self.lock.
        self.counts[name] += 1
        self.events[name].append(time.monotonic())

    def _capture(self):
        failures = 0
        while not self.stop_event.is_set():
            camera = None
            try:
                camera = self.camera_factory(self.settings)
                with self.lock:
                    self.generation += 1
                    generation = self.generation
                while not self.stop_event.is_set():
                    frame = camera.read()
                    captured_ns = time.monotonic_ns()
                    with self.lock:
                        self.camera_online = True
                        self.camera_error = None
                        self.camera_size = {"width": frame.shape[1], "height": frame.shape[0]}
                        self._count("captured")
                        frame_id = self.counts["captured"]
                    failures = 0
                    packet = FramePacket(frame_id, generation, captured_ns,
                                         datetime.now(timezone.utc).isoformat(), frame)
                    self.input_slot.put(packet)
            except Exception as exc:
                log.warning("Camera unavailable: %s", exc)
                with self.lock:
                    self.camera_online = False
                    self.camera_error = str(exc)
            finally:
                if camera is not None:
                    try:
                        camera.close()
                    except Exception:
                        log.exception("Camera release failed")
            delay = self.retry_delays[min(failures, len(self.retry_delays) - 1)]
            failures += 1
            self.stop_event.wait(delay)
        with self.lock:
            self.camera_online = False

    def _inference(self):
        detector = None
        try:
            detector = self.detector_factory(self.settings)
            detector.load()
            detector.warmup()
            with self.lock:
                self.model_ready = True
                self.detector_metadata = dict(detector.metadata)
            while not self.stop_event.is_set():
                packet = self.input_slot.take()
                if packet is None:
                    continue
                start = time.monotonic_ns()
                objects = detector.predict(packet.frame)
                finished = time.monotonic_ns()
                result = {
                    "schema_version": 1, "event": "detections", "session_id": self.session_id,
                    "frame_id": packet.frame_id, "captured_at": packet.captured_at,
                    "source_size": {"width": packet.frame.shape[1], "height": packet.frame.shape[0]},
                    "model": self.settings.model_path.stem,
                    "backend": detector.metadata.get("backend", self.settings.backend),
                    "timing_ms": {"queue_wait": (start - packet.captured_ns) / 1e6,
                                  "predict": (finished - start) / 1e6,
                                  "capture_to_result": (finished - packet.captured_ns) / 1e6},
                    "objects": objects,
                }
                with self.lock:
                    if packet.generation != self.generation or not self.camera_online:
                        continue
                    self.result, self.result_ns = result, packet.captured_ns
                    self.result_generation = packet.generation
                    self._count("detected")
                    self.latencies.append(result["timing_ms"]["capture_to_result"])
                self.preview_slot.put((packet, result))
        except Exception as exc:
            log.exception("Inference worker failed")
            with self.lock:
                self.fatal_error = str(exc)
                self.model_ready = False
        finally:
            if detector is not None:
                try:
                    detector.close()
                except Exception:
                    log.exception("Detector cleanup failed")

    def _encode(self):
        next_encode = 0.0
        try:
            while not self.stop_event.is_set():
                with self.lock:
                    subscribers = self.subscribers
                if not subscribers:
                    self.stop_event.wait(0.1)
                    continue
                if self.stop_event.wait(max(0, next_encode - time.monotonic())):
                    break
                item = self.preview_slot.take()
                if item is None:
                    continue
                packet, result = item
                if (time.monotonic_ns() - packet.captured_ns) / 1e9 > self.settings.stale_seconds:
                    continue
                data = self.encoder(packet.frame, result["objects"], self.settings.jpeg_quality)
                with self.lock:
                    self.jpeg = (packet.frame_id, packet.captured_ns, data)
                    self._count("encoded")
                next_encode = time.monotonic() + 1 / self.settings.preview_fps
        except Exception as exc:
            log.exception("Encoder failed")
            with self.lock:
                self.fatal_error = f"JPEG: {exc}"

    def subscribe_video(self, delta):
        with self.lock:
            self.subscribers = max(0, self.subscribers + delta)

    def latest_result(self):
        with self.lock:
            return self.result

    def latest_jpeg(self):
        with self.lock:
            return self.jpeg

    def status(self):
        now = time.monotonic()
        with self.lock:
            age = None if self.result_ns is None else (time.monotonic_ns() - self.result_ns) / 1e9
            if self.stop_event.is_set():
                state = "stopped"
            elif self.fatal_error:
                state = "error"
            elif not self.model_ready:
                state = "starting"
            elif not self.camera_online:
                state = "camera_unavailable"
            elif age is None or self.result_generation != self.generation:
                state = "starting"
            elif age > self.settings.stale_seconds:
                state = "stale"
            else:
                state = "ready"
            duration = min(10.0, max(0.001, now - self.started_at))
            rates = {k: round(sum(t >= now - duration for t in ts) / duration, 2) for k, ts in self.events.items()}
            return {
                "schema_version": 1, "event": "status", "session_id": self.session_id,
                "process_id": os.getpid(),
                "state": state, "ready": state == "ready", "backend": self.settings.backend,
                "model": self.settings.model_path.name, "detector": dict(self.detector_metadata),
                "configuration": {"imgsz": self.settings.imgsz, "confidence": self.settings.confidence,
                                  "iou": self.settings.iou, "max_det": self.settings.max_det,
                                  "preview_fps": self.settings.preview_fps},
                "camera": {"index": self.settings.camera_index, "online": self.camera_online,
                           "requested": {"width": self.settings.width, "height": self.settings.height,
                                         "fps": self.settings.camera_fps}, "actual_size": self.camera_size},
                "counts": dict(self.counts), "fps": rates, "input_dropped": self.input_slot.dropped,
                "preview_dropped": self.preview_slot.dropped, "video_subscribers": self.subscribers,
                "frame_age_ms": None if age is None else round(age * 1000, 2),
                "capture_to_result_ms": {"p50": percentile(self.latencies, .5), "p95": percentile(self.latencies, .95)},
                "last_error": self.fatal_error or self.camera_error,
                "uptime_seconds": round(now - self.started_at, 2),
                "workers": {thread.name: thread.is_alive() for thread in self.threads},
            }
