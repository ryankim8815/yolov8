"""Operator-confirmed camera targets. State is owned by the robot web process."""
import asyncio
import json
import math
import time
from contextlib import closing
from http.client import HTTPConnection, HTTPException as HTTPError
from urllib.parse import urlencode
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import Field

from .pick_plane import Calibration, CameraFrame, Input, PickPlane
from .robot_access_protocol import local_json
from .robot_access_proxy import request_host
from .robot_poses import HostLineCommand
from .store import DomainError, atomic_json


class Selection(Input):
    session_id: str = Field(min_length=1, max_length=64)
    frame_id: int = Field(ge=1)
    object_index: int = Field(ge=0)


class Approval(Input):
    approval_id: str = Field(pattern="^[a-f0-9]{32}$")


def read_camera(session_id=None, frame_id=None):
    # The Compose robot service does not own or open the Mac camera.
    query = urlencode({k: v for k, v in {"session_id": session_id, "frame_id": frame_id}.items() if v is not None})
    try:
        with closing(HTTPConnection("host.docker.internal", 8000, timeout=2)) as conn:
            conn.request("GET", "/api/detections/pick-frame?" + query)
            response = conn.getresponse()
            frame = json.loads(response.read())
            if response.status != 200:
                raise DomainError(frame.get("detail", "탐지 프레임을 읽지 못했습니다."), response.status)
            return frame
    except (OSError, HTTPError, ValueError) as exc:
        raise DomainError("탐지 서버에서 최신 영상을 받을 수 없습니다.", 503) from exc


def frame_reader(request):
    runtime = getattr(request.app.state, "pipeline", None)
    return runtime.pick_frame if runtime is not None else read_camera


def camera_key(camera):
    return json.dumps([camera.camera_id, camera.width, camera.height])


def center(obj):
    left, top, right, bottom = obj["xyxy"]
    return ((left + right) / 2, (top + bottom) / 2)


class PickTargets:
    def __init__(self, robot, directory):
        self.robot = robot
        self.path = directory / "pick-planes.json"
        self.last_path = directory / "pick-move.json"
        self.planes = json.loads(self.path.read_text()) if self.path.exists() else {}
        self.approvals = {}
        self.moves = {}
        self.task = None
        if self.last_path.exists():
            last = json.loads(self.last_path.read_text())
            self.moves[last["approval_id"]] = last
            if last["state"] in {"checking", "moving"}:
                self.record(last["approval_id"], "unknown", "서버가 재시작되었습니다. 실제 위치를 확인하세요.")

    @property
    def busy(self):
        return self.task is not None and not self.task.done()

    def record(self, identifier, state, message):
        last = dict(approval_id=identifier, state=state, message=message)
        atomic_json(self.last_path, last)
        self.moves[identifier] = last
        if len(self.moves) > 128:
            del self.moves[next(iter(self.moves))]
        return last

    def calibration(self, camera):
        entry = self.planes.get(camera_key(camera), {})
        return dict(camera=camera, revision=entry.get("revision"), corners=entry.get("corners", []))

    def save(self, body, active):
        if self.busy:
            raise DomainError("이동 확인이 끝난 뒤 다시 보정하세요.")
        if active != body.camera:
            raise DomainError("카메라 입력이 변경되었습니다. 보정을 다시 시작하세요.")
        if self.calibration(active)["revision"] != body.revision:
            raise DomainError("다른 화면에서 작업 평면을 수정했습니다. 보정을 다시 시작하세요.")
        PickPlane(body)
        entry = {**body.model_dump(), "revision": uuid4().hex}
        updated = {**self.planes, camera_key(active): entry}
        atomic_json(self.path, updated)
        self.planes = updated
        return self.calibration(active)

    async def preview(self, selection, reader):
        packet = await asyncio.to_thread(reader, selection.session_id, selection.frame_id)
        camera = CameraFrame.from_packet(packet)
        calibration = self.calibration(camera)
        if not calibration["revision"]:
            raise DomainError("먼저 이 카메라와 해상도의 작업 평면을 보정하세요.")
        if not 0 <= selection.object_index < len(packet["objects"]):
            raise DomainError("선택한 객체가 이 프레임에 없습니다.")
        obj = packet["objects"][selection.object_index]
        plane = PickPlane(Calibration(**calibration))
        pose = plane.target(center(obj))
        sdk = None
        reason = "파지 위치 이동에는 Mac SDK 제어 모드가 필요합니다."
        if self.robot.settings.access_backend == "mac-sdk":
            try:
                code, host = await asyncio.to_thread(request_host, "status", self.robot.settings)
                reason = host.get("detail") or "Mac SDK 상태를 확인할 수 없습니다."
                if code == 200:
                    if not host.get("line_supported"):
                        reason = "직선 이동을 지원하는 Mac SDK 작업자를 시작하세요."
                    elif host.get("can_move") and host.get("motion_token"):
                        sdk = HostLineCommand(pose=pose, session_id=host["session_id"], motion_token=host["motion_token"])
                        reason = None
                    else:
                        reason = host.get("motion_reason") or reason
            except HTTPException as exc:
                reason = str(exc.detail)
        current = time.monotonic()
        self.approvals = {k: v for k, v in self.approvals.items() if v["deadline"] > current}
        if len(self.approvals) >= 128:
            raise DomainError("대기 중인 승인이 많습니다. 잠시 뒤 다시 선택하세요.")
        identifier = uuid4().hex
        self.approvals[identifier] = dict(deadline=current + 30, camera=camera, revision=calibration["revision"],
                                          model=packet["model_version"], class_id=obj["class_id"], plane=plane,
                                          pose=pose, command=sdk, reason=reason)
        return dict(approval_id=identifier, expires_in=30, pose=pose, label=obj["label"],
                    confidence=obj["confidence"], motion_reason=reason)

    def approve(self, identifier, reader):
        # Single event loop, with no await between consuming and reserving the move.
        target = self.approvals.pop(identifier, None)
        if target is None or time.monotonic() >= target["deadline"]:
            raise DomainError("승인이 만료되었거나 이미 사용되었습니다. 다시 선택하세요.")
        if target["command"] is None:
            raise DomainError(target["reason"])
        if self.busy or self.robot.pose_tests.snapshot()["busy"]:
            raise DomainError("이전 로봇 이동이 끝난 뒤 다시 선택하세요.")
        state = self.record(identifier, "checking", "현재 영상에서 선택한 대상을 확인하고 있습니다.")
        self.task = asyncio.create_task(self.run(identifier, target, reader))
        return state

    def revalidate(self, target, frame):
        camera = CameraFrame.from_packet(frame)
        if (target["camera"] != camera or target["model"] != frame["model_version"] or
                self.calibration(camera)["revision"] != target["revision"]):
            raise DomainError("카메라·모델 또는 작업 평면이 변경되었습니다. 다시 선택하세요.")
        plane = target["plane"]
        matches = []
        for obj in frame["objects"]:
            if obj["class_id"] != target["class_id"]:
                continue
            pixel = center(obj)
            xyz = plane.project(pixel)
            if xyz is not None and math.dist(xyz, target["pose"][:3]) <= 10.0 + 1e-8:
                matches.append(pixel)
        if not matches:
            raise DomainError("선택한 중심에서 10 mm 이내에 같은 클래스의 객체가 없습니다.")
        if len(matches) != 1:
            raise DomainError("10 mm 이내에 같은 클래스의 객체가 여러 개입니다. 다시 선택하세요.")
        if not plane.contains(matches[0]):
            raise DomainError("현재 객체가 작업 영역 밖에 있습니다.")
        if time.monotonic() >= target["deadline"]:
            raise DomainError("승인이 만료되었습니다. 다시 선택하세요.")

    async def run(self, identifier, target, reader):
        dispatched = False
        try:
            frame = await asyncio.to_thread(reader, target["camera"].session_id)
            self.revalidate(target, frame)
            self.record(identifier, "moving", "파지 위치로 이동 중입니다.")
            dispatched = True
            code, data = await asyncio.to_thread(request_host, "line", self.robot.settings, target["command"])
            if 400 <= code < 500:
                self.record(identifier, "failed", data.get("detail", "SDK가 이동을 거절했습니다."))
            elif code == 200 and data.get("state") in {"completed", "failed", "unknown"}:
                self.record(identifier, data["state"], data["message"])
            else:
                self.record(identifier, "unknown", "이동 결과 미확인 · 실제 위치를 확인하세요.")
        except DomainError as exc:
            self.record(identifier, "failed", str(exc))
        except (Exception, asyncio.CancelledError):
            self.record(identifier, "unknown" if dispatched else "failed",
                        "이동 결과 미확인 · 실제 위치를 확인하세요." if dispatched else "최신 영상을 확인할 수 없습니다.")


router = APIRouter(prefix="/pick")


@router.get("/calibration")
async def calibration(request: Request):
    packet = await asyncio.to_thread(frame_reader(request))
    return request.app.state.robot.picks.calibration(CameraFrame.from_packet(packet))


@router.put("/calibration", dependencies=[Depends(local_json)])
async def save_calibration(body: Calibration, request: Request):
    packet = await asyncio.to_thread(frame_reader(request))
    return request.app.state.robot.picks.save(body, CameraFrame.from_packet(packet))


@router.post("/preview", dependencies=[Depends(local_json)])
async def preview(body: Selection, request: Request):
    return await request.app.state.robot.picks.preview(body, frame_reader(request))


@router.post("/cancel", dependencies=[Depends(local_json)])
async def cancel(body: Approval, request: Request):
    request.app.state.robot.picks.approvals.pop(body.approval_id, None)
    return {"ok": True}


@router.post("/approve", status_code=202, dependencies=[Depends(local_json)])
async def approve(body: Approval, request: Request):
    return request.app.state.robot.picks.approve(body.approval_id, frame_reader(request))


@router.get("/moves/{identifier}")
async def move_status(identifier: str, request: Request):
    move = request.app.state.robot.picks.moves.get(identifier)
    if move is None:
        raise DomainError("이 이동의 기록을 찾을 수 없습니다. 실제 위치를 확인하세요.", 404)
    return move
