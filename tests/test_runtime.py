import asyncio
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import create_app, jpeg_frames
from app.pipeline import Pipeline
from app.runtime import Runtime
from app.store import DomainError
from tests.fakes import Camera, Detector, encode, settings, wait_until
from tests.test_datasets import populated


class SwitchingDetector(Detector):
    def __init__(self, config):
        super().__init__(config)
        self.config=config
    def load(self):
        if self.config.model_path.stem=="bad":raise RuntimeError("bad model")


def factory(config):
    return Pipeline(config,camera_factory=Camera,detector_factory=SwitchingDetector,encoder=encode,retry_delays=(.01,))


@pytest.fixture
def runtime(tmp_path):
    rt=Runtime(settings(),factory,tmp_path/"state")
    rt.start()
    wait_until(lambda: rt.status()["ready"])
    yield rt
    rt.stop()


def register(rt,name):
    path=rt.store.root/f"{name}.pt";path.write_bytes(b"test")
    return rt.store.put("model",{"id":name,"name":name,"kind":"custom","classes":[],
        "formats":{"cpu":{"state":"ready","path":str(path)}}})


def test_switch_rolls_back_and_stream_session_changes(runtime):
    initial=runtime.status()["session_id"]
    register(runtime,"v2")
    operation=runtime.activate("v2")
    assert runtime.status()["ready"] is False
    wait_until(lambda: runtime.store.get("operation",operation["id"])["state"]=="completed")
    wait_until(lambda: runtime.status()["ready"])
    assert runtime.model_id=="v2" and runtime.status()["session_id"]!=initial
    assert runtime.latest_result()["model_version"]=="v2"
    register(runtime,"bad")
    operation=runtime.activate("bad")
    wait_until(lambda: runtime.store.get("operation",operation["id"])["state"]=="failed")
    wait_until(lambda: runtime.status()["ready"])
    assert runtime.model_id=="v2" and "bad model" in runtime.error
    assert runtime.store.get("operation", operation["id"])["restored_model_id"] == "v2"


def test_model_format_conflict_and_collection_conflicts(runtime):
    runtime.store.put("model",{"id":"unavailable","formats":{}})
    with pytest.raises(DomainError):runtime.activate("unavailable")
    cls=runtime.store.named("class","label");group=runtime.store.named("group","room")
    collection=runtime.create_collection({"class_id":cls["id"],"group_id":group["id"],"model_id":runtime.model_id,"interval_ms":250,"confidence":.5})
    runtime.start_collection(collection["id"])
    with pytest.raises(DomainError, match="사진 저장"):
        runtime.select_camera("other")
    register(runtime,"v2")
    with pytest.raises(DomainError):runtime.activate("v2")
    runtime.camera_stop()
    assert runtime.collector.active is None
    assert runtime.status()["state"]=="camera_off"
    runtime.camera_start()
    wait_until(lambda:runtime.status()["ready"])
    assert runtime.collector.active is None


def test_dashboard_camera_selection_routes_new_frames_and_rejects_missing_device(tmp_path, monkeypatch):
    devices = [{"id": "built-in", "index": 0, "name": "Built in"},
               {"id": "usb", "index": 1, "name": "USB"}]
    monkeypatch.setattr("app.capture.camera_devices", lambda: devices)
    opened = []

    class SourceCamera(Camera):
        def __init__(self, config):
            super().__init__(config)
            self.index = config.camera_index
            assert all(camera.closed for camera in opened)
            opened.append(self)

        def read(self):
            frame = super().read()
            frame.shape = (720, 800 + self.index, 3)
            return frame

    def source_pipeline(config):
        return Pipeline(config, camera_factory=SourceCamera, detector_factory=Detector, encoder=encode)

    application = create_app(settings(camera_autostart=False), source_pipeline, tmp_path)
    with TestClient(application) as client:
        select = lambda device: client.post("/api/camera/select", json={"device_id": device})
        assert client.get("/api/camera/devices").json() == devices
        assert not opened and client.get("/api/status").json()["state"] == "camera_off"
        assert select("built-in").status_code == 200
        wait_until(lambda: client.get("/readyz").is_success)
        first = client.get("/api/detections/latest").json()
        assert first["source_size"]["width"] == 800
        assert select("usb").status_code == 200
        wait_until(lambda: client.get("/readyz").is_success)
        second = client.get("/api/detections/latest").json()
        assert second["model_version"] == first["model_version"]
        assert second["source_size"]["width"] == 801 and second["session_id"] != first["session_id"]
        assert select("missing").status_code == 409
        assert select("usb").json()["session_id"] == second["session_id"]
        assert len(opened) == 2 and opened[0].closed
        stopped = client.post("/api/camera/stop").json()
        assert stopped["camera"]["id"] == "usb" and stopped["camera"]["index"] == 1
        client.post("/api/camera/start").raise_for_status()
        wait_until(lambda: client.get("/readyz").is_success)
        assert client.get("/api/detections/latest").json()["source_size"]["width"] == 801


def test_stream_survives_model_switch_with_session_headers(runtime):
    register(runtime,"v2")
    async def check():
        frames=jpeg_frames(runtime)
        try:
            first=await asyncio.wait_for(anext(frames),2)
            old=runtime.status()["session_id"]
            runtime.activate("v2")
            for _ in range(100):
                if runtime.model_id=="v2" and runtime.status()["ready"]:break
                await asyncio.sleep(.02)
            second=await asyncio.wait_for(anext(frames),2)
            assert f"X-Session-Id: {old}".encode() in first
            assert b"X-Model-Version: v2" in second
            assert f"X-Session-Id: {old}".encode() not in second
        finally:await frames.aclose()
        assert runtime.subscribers==0
    asyncio.run(check())


def test_selection_persists_but_explicit_path_wins(tmp_path):
    rt=Runtime(settings(),factory,tmp_path)
    rt.start();register(rt,"v2")
    operation=rt.activate("v2")
    wait_until(lambda:rt.store.get("operation",operation["id"])["state"]=="completed")
    rt.stop()
    other=Runtime(settings(),factory,tmp_path)
    assert other.model_id=="v2"
    other.stop()
    explicit=Runtime(settings(model_path_explicit=True),factory,tmp_path)
    assert explicit.model_id!="v2"
    explicit.stop()


def fake_job(runtime):
    populated(runtime.store)
    dataset=runtime.dataset()
    from app.chrome_model import BUILTIN_ONNX
    from app.runtime import artifact_hash
    runtime.store.put("model", {"id": "initial", "kind": "custom", "classes": dataset["classes"],
                                "formats": {"chrome": {"state": "ready", "path": str(BUILTIN_ONNX),
                                                        "sha256": artifact_hash(BUILTIN_ONNX)}}})
    return {"dataset_id": dataset["id"], "initial_model_id": "initial", "batch": 4, "epochs": 1, "patience": 1}


def test_browser_job_cancel_and_conflict(runtime):
    config = fake_job(runtime)
    job = runtime.create_job(config)
    assert job["state"] == "queued"
    with pytest.raises(DomainError):
        runtime.create_job(config)
    runtime.camera_stop()
    runtime.cancel_job(job["id"])
    assert runtime.store.get("job", job["id"])["state"] == "cancelled"
    assert runtime.active_job is None and runtime.busy is None
    assert runtime.pipeline is None and not runtime.camera_desired
    assert not any(m.get("job_id") == job["id"] for m in runtime.store.list("model"))


def test_rest_and_multiple_event_clients(tmp_path):
    with TestClient(create_app(settings(),factory,state_root=tmp_path)) as client:
        wait_until(lambda:client.get("/readyz").status_code==200)
        cls=client.post("/api/classes",json={"name":"한글 라벨"}).json()
        assert client.post("/api/classes",json={"name":"한글 라벨"}).status_code==409
        assert client.post("/api/classes",json={"name":"\n"}).status_code==422
        group=client.post("/api/capture-groups",json={"name":"창가"}).json()
        model=client.get("/api/models").json()["active_model_id"]
        collection=client.post("/api/collections",json={"class_id":cls["id"],"group_id":group["id"],"model_id":model}).json()
        assert client.post(f'/api/collections/{collection["id"]}/start').status_code==200
        with client.websocket_connect("/ws/events") as a,client.websocket_connect("/ws/events") as b:
            assert a.receive_json()["collection"]["id"]==collection["id"]
            assert b.receive_json()["collection"]["id"]==collection["id"]
            assert client.post(f'/api/collections/{collection["id"]}/heartbeat').status_code==200
            assert client.post("/api/camera/stop").status_code==200
            assert a.receive_json()["status"]["state"]=="camera_off"
        assert client.get("/readyz").status_code==503
        assert client.get("/api/detections/latest").status_code==503
        assert client.get("/api/collections/missing").status_code==404
        assert client.post("/api/training/jobs",json={"dataset_id":"bad","batch":0}).status_code==422
