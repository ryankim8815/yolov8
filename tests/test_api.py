import asyncio
import threading
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import TimedStreamingResponse, create_app, jpeg_frames
from app.pipeline import Pipeline
from tests.fakes import Camera, Detector, encode, settings, wait_until


def factory(config):
    return Pipeline(config, camera_factory=Camera, detector_factory=Detector,
                    encoder=encode, retry_delays=(.01,))


class APITests(unittest.TestCase):
    def test_ready_json_static_and_websocket_contract(self):
        application = create_app(settings(), pipeline_factory=factory)
        with TestClient(application) as client:
            self.assertEqual(client.get("/healthz").status_code, 200)
            self.assertIn("실시간 객체 탐지", client.get("/").text)
            self.assertEqual(client.get("/static/app.js").status_code, 200)
            wait_until(lambda: client.get("/readyz").status_code == 200)
            data = client.get("/api/detections/latest").json()
            self.assertEqual(data["objects"], [])
            with client.websocket_connect("/ws/detections") as socket:
                self.assertEqual(socket.receive_json()["event"], "status")
                result = socket.receive_json()
                self.assertEqual(result["event"], "detections")
                self.assertEqual(result["session_id"], data["session_id"])
        self.assertTrue(all(not t.is_alive() for t in application.state.pipeline.threads))

    def test_startup_and_error_do_not_block_health(self):
        gate = threading.Event()
        class Delayed(Detector):
            def load(self):
                gate.wait(1)
                raise RuntimeError("expected initialization failure")
        def delayed(config):
            return Pipeline(config, camera_factory=Camera, detector_factory=Delayed, encoder=encode)
        with TestClient(create_app(settings(), pipeline_factory=delayed)) as client:
            self.assertEqual(client.get("/healthz").status_code, 200)
            self.assertEqual(client.get("/readyz").status_code, 503)
            self.assertEqual(client.get("/api/detections/latest").status_code, 503)
            gate.set()
            wait_until(lambda: client.get("/api/status").json()["state"] == "error")
            self.assertEqual(client.get("/healthz").status_code, 200)

    def test_stale_result_is_not_served(self):
        application = create_app(settings(), pipeline_factory=factory)
        with TestClient(application) as client:
            wait_until(lambda: client.get("/readyz").status_code == 200)
            original = application.state.pipeline.status
            def stale():
                return {**original(), "ready": False, "state": "stale"}
            with patch.object(application.state.pipeline, "status", stale):
                self.assertEqual(client.get("/readyz").status_code, 503)
                self.assertEqual(client.get("/api/detections/latest").status_code, 503)
                with client.websocket_connect("/ws/detections") as socket:
                    self.assertEqual(socket.receive_json()["state"], "stale")


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_two_clients_share_encoder_and_cleanup_subscriptions(self):
        pipeline = factory(settings())
        pipeline.start()
        first, second = jpeg_frames(pipeline), jpeg_frames(pipeline)
        try:
            a, b = await asyncio.wait_for(asyncio.gather(anext(first), anext(second)), 3)
            self.assertIn(b"Content-Type: image/jpeg\r\n", a)
            self.assertIn(b"X-Frame-Id:", b)
            self.assertEqual(pipeline.status()["video_subscribers"], 2)
            await second.aclose()
            self.assertEqual(pipeline.status()["video_subscribers"], 1)
            await asyncio.wait_for(anext(first), 2)
        finally:
            await first.aclose()
            await second.aclose()
            pipeline.stop()
        self.assertEqual(pipeline.status()["video_subscribers"], 0)

    async def test_slow_send_times_out_and_closes_generator(self):
        closed = asyncio.Event()
        async def frames():
            try:
                yield b"data"
                await asyncio.sleep(100)
            finally:
                closed.set()
        async def send(message):
            if message["type"] == "http.response.body":
                await asyncio.sleep(100)
        async def receive():
            await asyncio.sleep(100)
        response = TimedStreamingResponse(frames(), timeout=.02)
        await asyncio.wait_for(response({"type": "http", "asgi": {"spec_version": "2.4"}}, receive, send), 1)
        self.assertTrue(closed.is_set())


if __name__ == "__main__":
    unittest.main()
