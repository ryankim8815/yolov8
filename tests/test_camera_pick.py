"""Camera targets are inert until an operator approves one matching live detection."""
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.pick_plane import Calibration, PickPlane
from app.robot_web import create_robot_app
from app.store import DomainError
from tests.fakes import wait_until


def pixel(s, t):
    # Deliberately non-affine image, including perspective and skew.
    return [(30 + 1.8*s + .25*t)/(1 + .002*s), (20 + .3*s + 1.6*t)/(1 + .002*s)]


def base(s, t):
    return [100 + s + 2*t, 210 - .5*s, 80 + 1.5*t]


def calibration():
    return dict(camera=dict(camera_id="cam-test", session_id="test-session", camera_generation=1, width=320, height=240),
                revision=None, corners=[dict(pixel=pixel(s, t), pose=base(s, t) + [10, 20, 30])
                                        for s, t in [(0, 0), (100, 0), (100, 100), (0, 100)]])


def test_taught_quadrilateral_and_interior():
    plane = PickPlane(Calibration(**calibration()))
    for s, t in [(0, 0), (100, 0), (100, 100), (0, 100), (37, 61)]:
        assert plane.target(pixel(s, t)) == pytest.approx(base(s, t) + [10, 20, 30])
    with pytest.raises(DomainError):
        plane.target(pixel(-10, 30))
    for field in ["pixel", "pose"]:
        for bad in ["duplicate", "crossed", "collinear"]:
            data = calibration()
            points = [p[field] for p in data["corners"]]
            if bad == "duplicate":
                points[1][:] = points[0]
            elif bad == "crossed":
                points[1][:], points[2][:] = points[2][:], points[1][:]
            else:
                points[2][:] = [(a+b)/2 for a, b in zip(points[0], points[1])]
            with pytest.raises(DomainError):
                PickPlane(Calibration(**data))
    data = calibration()
    data["corners"][3]["pose"][0] += 30
    with pytest.raises(DomainError, match="2 mm"):
        PickPlane(Calibration(**data))


def obj(s, t, cls=1):
    u, v = pixel(s, t)
    return dict(class_id=cls, label="부품", confidence=.96, xyxy=[u-3, v-4, u+3, v+4])


@pytest.fixture
def station(tmp_path, monkeypatch):
    original = dict(session_id="test-session", frame_id=17, model_version="parts-v2", camera_id="cam-test",
                    camera_generation=1, source_size={"width": 320, "height": 240},
                    objects=[obj(10, 10), obj(37, 61)])
    live = {**original, "frame_id": 25, "objects": [obj(39, 61), obj(10, 10)]}
    def read(session_id=None, frame_id=None):
        if frame_id is None:
            return live
        if (session_id, frame_id) != ("test-session", 17):
            raise DomainError("프레임 만료")
        return original
    status = dict(can_move=True, line_supported=True, session_id="sdk-test", motion_token="1"*32)
    moves = Mock(return_value=(200, {"state": "completed", "message": "완료"}))
    def host(op, settings, command=None):
        return (200, status) if op == "status" else moves(op, command)
    monkeypatch.setenv("ROBOT_STATE_DIR", str(tmp_path))
    monkeypatch.setenv("ROBOT_ACCESS_BACKEND", "mac-sdk")
    monkeypatch.setenv("ROBOT_ROS_PC_IP", "")
    monkeypatch.setattr("app.robot_pick.read_camera", read)
    monkeypatch.setattr("app.robot_pick.request_host", host)
    with TestClient(create_robot_app()) as client:
        response = client.put("/api/robot/pick/calibration", json=calibration())
        assert response.status_code == 200, response.text
        yield client, live, moves, status


URL = "/api/robot/pick"


def preview(client):
    result = client.post(URL + "/preview", json={"session_id": "test-session", "frame_id": 17, "object_index": 1})
    assert result.status_code == 200, result.text
    return result.json()


def finish(client, identifier):
    url = URL + "/moves/" + identifier
    wait_until(lambda: client.get(url).json()["state"] not in {"checking", "moving"})
    return client.get(url).json()


def test_only_one_move_to_original_preview(station):
    client, live, moves, _ = station
    result = preview(client)
    assert result["pose"] == pytest.approx(base(37, 61) + [10, 20, 30])
    moves.assert_not_called()
    ticket = {"approval_id": result["approval_id"]}
    # Injected coordinates are rejected, leaving the original confirmation intact.
    assert client.post(URL + "/approve", json={**ticket, "pose": [0]*6}).status_code == 422
    with ThreadPoolExecutor(max_workers=2) as threads:
        codes = list(threads.map(lambda _: client.post(URL + "/approve", json=ticket).status_code, range(2)))
    assert sorted(codes) == [202, 409]
    assert finish(client, result["approval_id"])["state"] == "completed"
    moves.assert_called_once()
    op, command = moves.call_args.args
    assert op == "line" and command.pose == result["pose"]


@pytest.mark.parametrize("change", ["cancel", "expired", "lost", "multiple", "drift", "camera", "model", "session", "calibration", "offline"])
def test_stale_or_ambiguous_targets_send_nothing(station, change):
    client, live, moves, _ = station
    identifier = preview(client)["approval_id"]
    ticket = {"approval_id": identifier}
    if change == "cancel":
        assert client.post(URL + "/cancel", json=ticket).status_code == 200
    elif change == "expired":
        client.app.state.robot.picks.approvals[identifier]["deadline"] = time.monotonic() - 1
    elif change == "lost":
        live["objects"] = []
    elif change == "multiple":
        live["objects"].append(obj(38, 61))
    elif change == "drift":
        live["objects"] = [obj(52, 61)]
    elif change == "camera":
        live["camera_generation"] += 1
    elif change == "model":
        live["model_version"] = "parts-v3"
    elif change == "session":
        live["session_id"] = "new-session"
    elif change == "calibration":
        updated = client.get(URL + "/calibration").json()
        assert client.put(URL + "/calibration", json=updated).status_code == 200
    elif change == "offline":
        with pytest.MonkeyPatch.context() as patch:
            patch.setattr("app.robot_pick.read_camera", Mock(side_effect=DomainError("영상 단절", 503)))
            assert client.post(URL + "/approve", json=ticket).status_code == 202
            assert finish(client, identifier)["state"] == "failed"
            moves.assert_not_called()
            return
    response = client.post(URL + "/approve", json=ticket)
    if response.status_code == 202:
        assert finish(client, identifier)["state"] == "failed"
    else:
        assert response.status_code == 409
    moves.assert_not_called()


def test_offline_sdk_can_preview_and_response_loss_is_unknown(station):
    client, live, moves, sdk = station
    sdk["can_move"] = False
    result = preview(client)
    assert result["motion_reason"]
    assert client.post(URL + "/approve", json={"approval_id": result["approval_id"]}).status_code == 409
    moves.assert_not_called()
    sdk["can_move"] = True
    moves.side_effect = ConnectionError()
    identifier = preview(client)["approval_id"]
    assert client.post(URL + "/approve", json={"approval_id": identifier}).status_code == 202
    assert finish(client, identifier)["state"] == "unknown"
    assert client.post(URL + "/approve", json={"approval_id": identifier}).status_code == 409
    moves.assert_called_once()


def test_native_dashboard_uses_displayed_frame_and_camera_identity(tmp_path, monkeypatch):
    from app.main import create_app
    from app.pipeline import Pipeline
    from tests.fakes import Camera, Detector, encode, settings

    class TestCamera(Camera):
        device_id = "built-in"

    class TestDetector(Detector):
        def predict(self, frame):
            return [obj(37, 61)]

    def factory(config):
        return Pipeline(config, camera_factory=TestCamera, detector_factory=TestDetector, encoder=encode)

    monkeypatch.delenv("YOLO_ROBOT_WEB_OWNER", raising=False)
    monkeypatch.setenv("ROBOT_ROS_PC_IP", "")
    monkeypatch.setenv("ROBOT_ACCESS_BACKEND", "ros")
    with TestClient(create_app(settings(), factory, tmp_path)) as client:
        with client.websocket_connect("/ws/detections?preview=true") as ws:
            packet = ws.receive_json()
            while packet["event"] != "detections":
                packet = ws.receive_json()
            assert ws.receive_bytes() == f"fake-jpeg-{packet['frame_id']}".encode()
            ref = {k: packet[k] for k in ("session_id", "frame_id")}
            stored = client.get("/api/detections/pick-frame", params=ref).json()
            assert stored["objects"] == packet["objects"]
            config = client.get(URL + "/calibration").json()
            assert config["camera"]["camera_id"] == "built-in"
            config["corners"] = calibration()["corners"]
            assert client.put(URL + "/calibration", json=config).status_code == 200
            response = client.post(URL + "/preview", json={**ref, "object_index": 0})
            assert response.json()["pose"] == pytest.approx(base(37, 61) + [10, 20, 30])
            assert client.get("/api/detections/pick-frame", params={**ref, "session_id": "old"}).status_code == 409
