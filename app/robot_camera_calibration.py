"""Robot-owned marker registration and revisions; camera work stays on the Mac."""
import asyncio
import copy
import json
import math
import os
from http.client import HTTPConnection,HTTPException
from uuid import uuid4

from fastapi import APIRouter,Depends,Request
from pydantic import Field,FiniteFloat,StrictBool,model_validator

from .pick_plane import Input
from .robot_access_protocol import local_json
from .store import DomainError,atomic_json,now


class MarkerConfig(Input):
    marker_id: int=Field(default=0,ge=0,le=49)
    side_mm: FiniteFloat=Field(default=100.,ge=40,le=400)
    corners_base_mm: list[list[FiniteFloat]]=Field(min_length=4,max_length=4)

    @model_validator(mode="after")
    def square(self):
        p=self.corners_base_mm;s=self.side_mm
        if any(len(v)!=3 or any(abs(x)>5000 for x in v) for v in p):raise ValueError("각 모서리의 BASE XYZ(mm)를 입력하세요.")
        tolerance=min(1.,s*.01)
        for i in range(4):
            if abs(math.dist(p[i],p[(i+1)%4])-s)>tolerance:raise ValueError("모서리 간 거리가 마커의 검은 사각형 한 변과 다릅니다.")
        if any(abs(math.dist(p[i],p[i+2])-s*math.sqrt(2))>tolerance for i in (0,1)):
            raise ValueError("마커의 A→B→C→D 순서와 정사각형 대각선 길이를 확인하세요.")
        midpoint=[(p[0][i]+p[2][i]-p[1][i]-p[3][i])/2 for i in range(3)]
        if math.hypot(*midpoint)>tolerance:raise ValueError("네 모서리는 같은 평면의 정사각형이어야 합니다.")
        return self


class Registration(Input):
    revision: str|None=Field(default=None,max_length=32)
    enabled: StrictBool=True
    config: MarkerConfig


class Revision(Input):
    revision: str=Field(pattern="^[a-f0-9]{32}$")


def native_call(action,body=None,*,timeout=10):
    host="host.docker.internal" if os.getenv("ROBOT_BRIDGE_NETWORK")=="compose" else "127.0.0.1"
    connection=HTTPConnection(host,8000,timeout=timeout)
    try:
        connection.request("POST","/api/camera/marker/"+action,json.dumps(body or {},allow_nan=False),{"Content-Type":"application/json"})
        response=connection.getresponse();raw=response.read(4_000_001)
        if len(raw)>4_000_000:raise DomainError("카메라 응답이 너무 큽니다.",503)
        result=json.loads(raw)
        if response.status!=200:raise DomainError(result.get("detail") or "카메라 보정을 확인하세요.",response.status)
        return result
    except (OSError,HTTPException,ValueError) as exc:raise DomainError("Mac 카메라 서비스에 연결할 수 없습니다.",503) from exc
    finally:connection.close()


def joints(robot):
    status=robot.snapshot()
    topic=next((t for t in status["topics"] if t["name"]==status["display_joint_topic"]),None)
    if status["state"] not in ("live","monitoring") or not topic or topic["state"]!="live" or topic["age_seconds"]>.5:
        raise DomainError("0.5초 이내의 실제 로봇 관절 수신이 필요합니다. 로봇 연결을 확인하세요.")
    message=topic["message"];values={}
    import re
    for name,value in zip(message["name"],message["position"]):
        match=re.search(r"(?:^|[/_])joint_?([1-6])$",name,re.I)
        if match:
            index=int(match[1])
            if index in values:raise DomainError("중복된 관절 수신값입니다.")
            values[index]=math.degrees(value)
    if len(values)!=6 or not all(math.isfinite(v) for v in values.values()):raise DomainError("6개 관절의 실제 수신값이 필요합니다.")
    return [values[i] for i in range(1,7)]


class CameraCalibration:
    def __init__(self,robot,directory):
        self.robot=robot;self.path=directory/"camera-marker.json";self.busy=False;self.operation=0
        self.value=json.loads(self.path.read_text()) if self.path.exists() else dict(revision=None,enabled=False,config=None,result=None,message="마커 좌표 등록 후 캘리브레이션하세요.")
        # Persist the measurements for review, but a process restart never restores execution authority.
        self.valid=False
        if self.enabled:self.value["message"]="서비스가 재시작되었습니다. 저장한 마커 좌표를 확인하고 다시 캘리브레이션하세요."

    @property
    def enabled(self):return self.value["enabled"]

    def status(self):
        return dict(**copy.deepcopy(self.value),busy=self.busy,state="calibrating" if self.busy else "ready" if self.valid else "required" if self.enabled else "unconfigured")

    def invalidate(self,message):
        self.valid=False;self.operation+=1;self.value.update(revision=uuid4().hex,result=None,message=message)
        self.robot.picks.approvals.clear();self.robot.scenario.prepared=None
        if self.robot.presets:
            self.robot.presets.detections.snapshots.clear()
            self.robot.presets.voice.invalidate("카메라 보정 변경으로 실행 확인을 취소했습니다.")
        atomic_json(self.path,self.value)

    def save(self,body):
        self.robot.scenario.require_idle()
        if body.revision!=self.value["revision"]:raise DomainError("다른 화면에서 보정이 변경되었습니다. 다시 불러오세요.",412)
        self.value.update(enabled=body.enabled,config=body.config.model_dump())
        self.invalidate("마커 좌표를 저장했습니다. 카메라와 로봇을 고정하고 캘리브레이션하세요." if body.enabled else "마커 BASE 보정 사용을 껐습니다. 기존 작업면 보정을 사용합니다.")
        return self.status()

    async def run(self,body):
        self.robot.scenario.require_idle()
        if body.revision!=self.value["revision"]:raise DomainError("마커 등록 버전이 변경되었습니다. 다시 불러오세요.",412)
        if not self.enabled or not self.value["config"]:raise DomainError("마커의 BASE 좌표를 먼저 등록하세요.")
        start=joints(self.robot)
        self.invalidate("보정 중 · 카메라·로봇·마커를 움직이지 마세요.")
        operation=self.operation;self.busy=True;task=None
        try:
            task=asyncio.create_task(asyncio.to_thread(native_call,"solve",self.value["config"]))
            while not task.done():
                await asyncio.sleep(.075)
                current=joints(self.robot)
                if max(abs(a-b) for a,b in zip(start,current))>.2:raise DomainError("보정 중 로봇 자세가 변했습니다. 정지한 뒤 다시 보정하세요.")
                if operation!=self.operation:raise DomainError("보정이 중단되었습니다. 다시 캘리브레이션하세요.")
            result=await task
            if operation!=self.operation:raise DomainError("보정이 취소되었습니다.")
            self.value.update(revision=uuid4().hex,result=result,calibrated_at=now(),message="보정 완료 · 카메라 또는 마커 이동 후 다시 캘리브레이션하세요.")
            self.valid=True;atomic_json(self.path,self.value)
        except BaseException as exc:
            self.valid=False;self.value.update(result=None,message=str(exc) or "보정을 취소했습니다.");atomic_json(self.path,self.value)
            if task and not task.done():task.cancel()
            raise
        finally:self.busy=False
        return self.status()

    def require_valid(self):
        if not self.valid or not self.value.get("result"):raise DomainError("카메라 BASE 보정이 필요합니다. 캘리브레이션 버튼을 누르세요.",412)
        return self.value["result"]["token"]

    async def view(self):
        token=self.value["result"]["token"] if self.valid and self.value.get("result") else None
        revision=self.value["revision"]
        data=await asyncio.to_thread(native_call,"view",dict(token=token))
        if revision!=self.value["revision"]:data["calibration"]=None
        elif token and data.get("error"):self.invalidate(data["error"])
        return dict(**data,status=self.status(),robot=self.robot.snapshot())

    async def object(self,packet,index):
        token=self.require_valid();revision=self.value["revision"]
        try:
            value=await asyncio.to_thread(native_call,"object",dict(token=token,session_id=packet["session_id"],frame_id=packet["frame_id"],object_index=index))
        except DomainError as exc:
            if exc.status==412 and revision==self.value["revision"]:self.invalidate(str(exc))
            raise
        if revision!=self.value["revision"]:raise DomainError("좌표 계산 중 보정이 변경되었습니다.",412)
        return value


router=APIRouter(prefix="/camera-calibration")

@router.get("")
async def status(request:Request):return request.app.state.robot.camera_calibration.status()

@router.put("",dependencies=[Depends(local_json)])
async def save(body:Registration,request:Request):return request.app.state.robot.camera_calibration.save(body)

@router.post("/run",dependencies=[Depends(local_json)])
async def run(body:Revision,request:Request):return await request.app.state.robot.camera_calibration.run(body)

@router.get("/view")
async def view(request:Request):return await request.app.state.robot.camera_calibration.view()
