"""Server-owned YOLO snapshots. Browser coordinates never become actuator targets."""
import asyncio
import copy
import hashlib
import json
import math
import os
import time
from http.client import HTTPConnection, HTTPException

from . import robot_pick
from .pick_plane import Calibration, CameraFrame, PickPlane
from .robot_preset_config import MotionPreset, uid
from .store import DomainError


def read_yolo_catalog():
    host="host.docker.internal" if os.getenv("ROBOT_BRIDGE_NETWORK")=="compose" else "127.0.0.1"
    def get(path):
        conn=HTTPConnection(host,8000,timeout=3)
        try:
            conn.request("GET",path)
            response=conn.getresponse();body=json.loads(response.read(2_000_000))
            if response.status!=200:raise DomainError(body.get("detail") or "탐지 서버를 확인하세요.",response.status)
            return body
        except (OSError,HTTPException,ValueError) as exc:
            raise DomainError("Mac 탐지 서버에 연결할 수 없습니다.",503) from exc
        finally:conn.close()
    models=get("/api/models");status=get("/api/status")
    version=models["active_model_id"]
    if status.get("model_version")!=version:raise DomainError("모델 전환 중입니다. 클래스 목록을 다시 불러오세요.")
    model=next((m for m in models["models"] if m["id"]==version),None)
    if model is None:raise DomainError("현재 모델의 클래스 정보를 확인할 수 없습니다.")
    return dict(model_version=version,model_name=model["name"],classes=model.get("classes",[]),
                camera=status.get("camera"),ready=bool(status.get("ready")),state=status.get("state"))


def signature(preset):
    return hashlib.sha256(json.dumps(preset,sort_keys=True,ensure_ascii=False,allow_nan=False).encode()).hexdigest()


class PresetDetections:
    def __init__(self,engine):
        self.engine=engine;self.snapshots={}

    @property
    def robot(self):return self.engine.robot

    def criteria(self,p):
        if p["object_source"]!="yolo":raise DomainError("YOLOv8 탐지값을 선택한 프리셋에서 사용하세요.")
        if p["yolo"]["class_id"] is None or not p["yolo"]["model_version"]:
            raise DomainError("현재 YOLO 모델의 대상 클래스를 선택하고 저장하세요.")
        if sum(s["kind"]=="grasp" for s in p["steps"])!=1:
            raise DomainError("YOLO 프리셋에 자동 파지 묶음을 한 개 연결하세요.")

    async def require_ready(self,p,kin=None):
        if kin is None:_,kin=await self.engine.legacy.inspect()
        expected=p["context"]["standby_joints"]
        width=self.engine.legacy.idle_width(p["context"])
        position=self.robot.hand.position_for(width)
        hand=kin.get("hand") or {}
        actual=kin.get("current_joints")
        if (not isinstance(actual,list) or len(actual)!=6 or any(not isinstance(a,(int,float)) or not math.isfinite(a) for a in actual) or
                any(abs(a-b)>.5 for a,b in zip(actual,expected)) or
                type(hand.get("position")) is not int or abs(hand["position"]-position)>2):
            raise DomainError("인식 자세가 다릅니다. ‘인식 자세 준비’를 먼저 화면에서 승인하세요.")
        return kin

    def check(self,p,identifier,*,approved=False):
        snap=self.snapshots.get(identifier)
        if snap is None or (not approved and snap["deadline"]<=time.monotonic()):
            raise DomainError("YOLO 대상 확인이 만료되었습니다. 최신 대상을 다시 확인하세요.")
        if snap["signature"]!=signature(p):raise DomainError("프리셋이 변경되었습니다. 대상을 다시 확인하세요.",412)
        if snap["versions"]!=self.engine.legacy.versions() or snap["floor_revision"]!=self.robot.floor.value["revision"]:
            raise DomainError("중단 요청 또는 장비·공통 설정 변경으로 YOLO 확인을 취소했습니다.",412)
        current=self.robot.picks.calibration(snap["camera"],p["region"])
        if current["revision"]!=snap["calibration_revision"]:
            raise DomainError("작업면 보정이 변경되었습니다. 대상을 다시 확인하세요.",412)
        return snap

    def public(self,snap):
        valid=[c for c in snap["candidates"] if not c["reason"]]
        selected=snap["candidates"][0]["id"] if snap["policy"]=="unique" and len(snap["candidates"])==1 and len(valid)==1 else None
        count=len(snap["candidates"])
        message=("선택 조건에 맞는 대상이 없습니다." if not count else
                 "작업면 보정과 탐지 상자 범위를 확인하세요." if not valid else
                 "대상 1개를 확정했습니다. 경로를 확인하세요." if selected else
                 f"후보 {count}개 · 화면에서 실행할 대상을 선택하세요.")
        return dict(snapshot_id=snap["id"],preset_id=snap["preset_id"],revision=snap["revision"],
                    expires_in=max(0,snap["deadline"]-time.monotonic()),frame_id=snap["frame_id"],
                    camera=snap["camera"].model_dump(),model_version=snap["model"],region=snap["region"],
                    calibration_revision=snap["calibration_revision"],captured_at=snap["captured_at"],
                    candidates=copy.deepcopy(snap["candidates"]),selected_id=selected,
                    state="no_match" if not valid else "selected" if selected else "selection_required",message=message)

    async def capture(self,p,*,hardware=False,reader=None):
        self.criteria(p);self.engine.legacy.require_idle()
        versions=self.engine.legacy.versions();floor=self.robot.floor.value["revision"]
        if hardware:await self.require_ready(p)
        reader=reader or robot_pick.read_camera
        packet=await asyncio.to_thread(reader)
        camera=CameraFrame.from_packet(packet)
        if packet["model_version"]!=p["yolo"]["model_version"]:
            raise DomainError("현재 YOLO 모델이 프리셋의 모델과 다릅니다. 클래스 목록을 다시 불러와 저장하세요.")
        calibration=self.robot.picks.calibration(camera,p["region"])
        if not calibration["revision"]:raise DomainError("이 카메라·해상도의 상품 파지 영역을 먼저 보정하세요.")
        plane=PickPlane(Calibration(**calibration));candidates=[];targets={};identifier=uid()
        for index,obj in enumerate(packet["objects"]):
            if obj["class_id"]!=p["yolo"]["class_id"] or obj["confidence"]<p["yolo"]["min_confidence"]:continue
            pixel=robot_pick.center(obj)
            if not plane.contains(pixel):continue
            key=uid();pose=None;estimate={};reason=None
            try:
                region,_,_=self.robot.picks.region_for(camera,pixel)
                if region!=p["region"]:continue
                pose=plane.target(pixel);estimate=plane.gripper_estimate(obj["xyxy"],tcp=pose[:3])
                if estimate.get("reason"):raise DomainError(estimate["reason"])
                # Planar extents are estimated; the normal-axis depth remains a preset value.
                normal_axis=max(range(3),key=lambda axis:abs(plane.normal[axis]))
                spans=[max(pt[i] for pt in estimate["footprint_base_mm"])-min(pt[i] for pt in estimate["footprint_base_mm"]) for i in range(3)]
                size=copy.deepcopy(p["context"]["virtual"][p["region"]]["size_mm"])
                for i in range(3):
                    if i!=normal_axis:size[i]=max(.001,spans[i])
                resolved=dict(pose=pose,normal=list(plane.normal),size_mm=size,width_mm=estimate["width_mm"],opening_mm=estimate["opening_mm"],
                              planar_size_mm=[spans[i] for i in range(3) if i!=normal_axis],camera=camera.model_dump(),
                              label=obj["label"],confidence=obj["confidence"],candidate_id=key,snapshot_id=identifier,
                              frame_id=packet["frame_id"],model_version=packet["model_version"],calibration_revision=calibration["revision"])
                targets[key]=dict(resolved=resolved,pose=pose,plane=plane,xyxy=copy.deepcopy(obj["xyxy"]),class_id=obj["class_id"],
                                  camera=camera,model=packet["model_version"],revision=calibration["revision"],region=p["region"])
            except DomainError as exc:reason=str(exc)
            candidates.append(dict(id=key,object_index=index,label=obj["label"],confidence=obj["confidence"],xyxy=copy.deepcopy(obj["xyxy"]),
                                   pose=pose,width_mm=estimate.get("width_mm"),opening_mm=estimate.get("opening_mm"),
                                   planar_size_mm=targets[key]["resolved"]["planar_size_mm"] if key in targets else None,reason=reason))
        if versions!=self.engine.legacy.versions() or floor!=self.robot.floor.value["revision"]:
            raise DomainError("대상 확인 중 설정 또는 중단 상태가 변경되었습니다.",412)
        if self.robot.picks.calibration(camera,p["region"])["revision"]!=calibration["revision"]:
            raise DomainError("대상 확인 중 작업면 보정이 변경되었습니다.",412)
        self.engine.legacy.require_idle()
        self.snapshots={k:v for k,v in self.snapshots.items() if v["deadline"]>time.monotonic()}
        if len(self.snapshots)>=128:raise DomainError("대기 중인 대상 확인이 많습니다. 잠시 후 다시 확인하세요.")
        snap=dict(id=identifier,preset_id=p["id"],revision=p["revision"],signature=signature(p),versions=versions,floor_revision=floor,
                  deadline=time.monotonic()+30,camera=camera,model=packet["model_version"],frame_id=packet["frame_id"],
                  captured_at=packet.get("captured_at"),region=p["region"],calibration_revision=calibration["revision"],
                  policy=p["yolo"]["selection"],candidates=candidates,targets=targets,reader=reader)
        self.snapshots[identifier]=snap
        return self.public(snap)

    def bind(self,p,snapshot_id,candidate_id=None):
        snap=self.check(p,snapshot_id)
        candidate_id=candidate_id or self.public(snap)["selected_id"]
        if not candidate_id:raise DomainError("실행할 YOLO 대상을 화면에서 선택하세요.")
        target=snap["targets"].get(candidate_id)
        if target is None:raise DomainError("선택한 객체를 사용할 수 없습니다. 최신 대상을 다시 확인하세요.")
        return dict(**target,deadline=snap["deadline"],snapshot_id=snapshot_id,candidate_id=candidate_id,reader=snap["reader"],
                    min_confidence=p["yolo"]["min_confidence"])

    async def revalidate(self,p,binding,*,approved=False):
        self.check(p,binding["snapshot_id"],approved=approved)
        frame=await asyncio.to_thread(binding["reader"],binding["camera"].session_id)
        obj=self.robot.picks.revalidate({**binding,"approved":approved},frame)
        if obj["confidence"]<binding["min_confidence"]:raise DomainError("대상의 신뢰도가 낮아졌습니다. YOLO 대상을 다시 확인하세요.")
        estimate=binding["plane"].gripper_estimate(obj["xyxy"],tcp=binding["pose"][:3])
        if estimate.get("reason"):raise DomainError(estimate["reason"])
        if estimate["opening_mm"]>binding["resolved"]["opening_mm"]+1e-8:
            raise DomainError("대상에 필요한 벌림이 달라졌습니다. 경로를 다시 확인하고 승인하세요.")
        self.check(p,binding["snapshot_id"],approved=approved)
        return obj

