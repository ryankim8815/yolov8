"""Variable-length saved-coordinate jobs. The existing SDK owner remains the only actuator."""
import asyncio
import copy
import time
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import Field

from .pick_plane import Input
from .robot_access_protocol import local_json
from .robot_arc import validate_arc
from .robot_preset_config import MotionPreset, PresetStep, PresetLibrary, compile_preset, uid, child_id
from .robot_preset_detection import PresetDetections, read_yolo_catalog
from .robot_pick import frame_reader
from .store import DomainError


class PresetPreview(Input):
    preset: MotionPreset | None = None
    revision: str | None = None
    step_id: str | None = Field(default=None,min_length=1,max_length=64,pattern=r"^[a-zA-Z0-9_-]+$")
    snapshot_id: str | None = Field(default=None,pattern=r"^[a-f0-9]{32}$")
    candidate_id: str | None = Field(default=None,pattern=r"^[a-f0-9]{32}$")


class DetectionRequest(PresetPreview):
    hardware: bool = False


class Approval(Input):
    approval_id: str


class CopyPreset(Input):
    revision: str


class PresetEngine:
    def __init__(self,robot,directory):
        self.robot=robot;self.legacy=robot.scenario;self.library=PresetLibrary(directory,robot)
        self.voice=None;self.detections=PresetDetections(self)

    def compile(self,preset,detected=None):
        return compile_preset(preset,self.robot.hand,self.robot.floor.value["z_mm"],detected=detected)

    async def catalog(self):return await asyncio.to_thread(read_yolo_catalog)

    def check_versions(self,target):
        p=self.library.get(target["preset_id"])
        if p["revision"]!=target["preset_revision"] or self.robot.floor.value["revision"]!=target["floor_revision"]:
            raise DomainError("프리셋 또는 바닥 기준이 변경되었습니다. 다시 확인하세요.",412)
        if target.get("versions") is not None and target["versions"]!=self.legacy.versions():
            raise DomainError("장비 또는 공통 설정이 변경되었습니다.",412)
        if target.get("detection"):
            self.detections.check(p,target["detection"]["snapshot_id"],approved=target.get("approved",False))

    def save(self,preset,create=False):
        self.legacy.require_idle()
        result=self.library.save(preset,create)
        if self.voice:self.voice.invalidate("프리셋 변경으로 확인 대기를 취소했습니다.")
        return result

    async def preview(self,identifier,revision,step_id=None,snapshot_id=None,candidate_id=None,*,recognition=False):
        self.legacy.require_idle();versions=self.legacy.versions();floor_revision=self.robot.floor.value["revision"]
        p=self.library.get(identifier)
        if revision!=p["revision"]:raise DomainError("프리셋이 변경되었습니다. 최신 설정을 불러오세요.",412)
        original=copy.deepcopy(p);binding=None
        if recognition:
            # Preparation has its own approval and never consumes a YOLO object.
            step=next((s for s in p["steps"] if s["kind"]=="prepare"),None)
            step=PresetStep.model_validate(step) if step else PresetStep(kind="prepare",source="standby",name="인식 자세 준비")
            step=step.model_copy(update={"id":child_id(p["id"],"recognition"),"source":"standby","target":None,"reference_id":None,"space":"joint","j1_only":False})
            p.update(object_source="saved",steps=[step.model_dump()],range_start=None,range_end=None)
        elif p["object_source"]=="yolo":
            binding=self.detections.bind(p,snapshot_id,candidate_id)
            await self.detections.current_choice(p,binding.get("voice_choice"),hardware=True,step_id=step_id)
            await self.detections.revalidate(p,binding)
        if step_id:
            selected=next((s for s in p["steps"] if s["id"]==step_id),None)
            if selected is None:raise DomainError("단계를 찾을 수 없습니다.",404)
            if selected["kind"]=="checkpoint":raise DomainError("좌표 확인 행에는 실행할 동작이 없습니다.",422)
            p=MotionPreset.model_validate({**p,"range_start":step_id,"range_end":step_id}).model_dump()
        recipe=self.compile(p,binding["resolved"] if binding else None)
        if recipe["errors"]:raise DomainError(" ".join(recipe["errors"]))
        steps=copy.deepcopy(recipe["steps"])
        status,kin=await self.legacy.inspect()
        if binding:await self.detections.require_ready(original,kin)
        context={k:kin[k] for k in ("session_id","tcp_name","reference_tcp")}
        # Each inspection also reads the flange gripper. Resolve repeated targets
        # once, in the SDK's bounded batches, rather than reopening it per step.
        targets={space:list(dict.fromkeys(tuple(s["target"]) for s in steps
                  if s["kind"] in {"joint","line","circle"} and s["space"]==space))
                 for space in ("joint","task")}
        resolved={"joint":{},"task":{}}
        for offset in range(max((len(targets["joint"])+4)//5,(len(targets["task"])+3)//4)):
            joints=targets["joint"][offset*5:offset*5+5];poses=targets["task"][offset*4:offset*4+4]
            extra_status,extra=await self.legacy.inspect(joints=[list(q) for q in joints],poses=[list(pose) for pose in poses])
            if any(extra.get(k)!=v for k,v in context.items()) or extra_status["motion_token"]!=status["motion_token"]:
                raise DomainError("SDK 세션·TCP·위치가 변경되었습니다. 다시 경로를 확인하세요.")
            if len(extra.get("forward",[]))!=len(joints) or len(extra.get("solutions",[]))!=len(poses):
                raise DomainError("SDK 좌표 계산 결과를 확인할 수 없습니다. 다시 경로를 확인하세요.")
            resolved["joint"].update(zip(joints,extra["forward"]))
            resolved["task"].update(zip(poses,extra["solutions"]))
        previous=kin["current_tcp"]
        for step in steps:
            kind=step["kind"]
            if kind in {"joint","line","circle"}:
                target=step["target"]
                calculated=resolved[step["space"]][tuple(target)]
                task=calculated if step["space"]=="joint" else target
                if kind=="joint" and step["space"]=="task":
                    solution=calculated
                    if not solution or len(solution)!=6:raise DomainError("관절 목표 해를 찾을 수 없습니다.")
                    step["target"]=solution
                elif kind!="joint":
                    if step["space"]=="joint":step["expected_joints"]=target
                    step["target"]=task
                    if kind=="circle":
                        if not status.get("circle_supported"):raise DomainError("원호 이동을 지원하는 SDK가 필요합니다.")
                        validate_arc(previous,step["via_pose"],task)
                previous=task
            elif kind=="gripper":
                hand=kin.get("hand") or {};speed=step["speed"]
                if hand.get("mode")!=5 or hand.get("error")!=0 or not hand.get("torque_known") or hand.get("moving") or type(hand.get("position")) is not int:
                    raise DomainError("그리퍼 상태와 전류 기반 위치 모드를 확인하세요.")
                if not 0<hand.get("goal_current_ma",0)<=hand.get("limit_ma",0):raise DomainError("그리퍼 전류 설정을 확인하세요.")
                if speed["speed"]*100>hand.get("velocity_limit",0) or speed["acceleration"]>hand.get("acceleration_limit",0):
                    raise DomainError("그리퍼 속도·가속도가 장치 상한을 넘습니다.")
                if step.get("contact"):
                    threshold=self.robot.hand.contact["threshold_ma"]
                    if threshold is None or threshold>hand["goal_current_ma"]:raise DomainError("접촉 전류 임계값을 설정하세요.")
                    step.update(position=700,contact_ma=threshold)
                else:step.update(position=self.robot.hand.position_for(step["opening_mm"]),contact_ma=None)
        if versions!=self.legacy.versions() or self.library.get(identifier)["revision"]!=revision or floor_revision!=self.robot.floor.value["revision"]:
            raise DomainError("경로 확인 중 설정이 변경되었습니다.",412)
        target=dict(kind="preset",preset_id=identifier,preset_revision=revision,floor_revision=floor_revision,
                    config=p["context"],status=status,kin=kin,steps=steps,label=p["name"]+(" · 인식 자세 준비" if recognition else ""),cancelled=False,
                    detection=binding,recognition_prepare=recognition,preset=original,step_id=step_id)
        if binding:self.detections.check(original,binding["snapshot_id"])
        ticket=self.legacy.ticket(target)
        if binding:
            self.robot.picks.approvals[ticket]["deadline"]=min(self.robot.picks.approvals[ticket]["deadline"],binding["deadline"])
        return dict(approval_id=ticket,expires_in=max(0,self.robot.picks.approvals[ticket]["deadline"]-time.monotonic()),preset_id=identifier,revision=revision,
                    name=target["label"],steps=steps,total_steps=len(steps),tcp_name=kin["tcp_name"],recognition_prepare=recognition,
                    detected=copy.deepcopy(binding["resolved"]) if binding else None)

    async def approve(self,identifier,*,from_voice=False):
        target=self.robot.picks.approvals.pop(identifier,None)
        if target is None or target["deadline"]<=time.monotonic() or target.get("kind")!="preset":
            raise DomainError("승인이 만료되었거나 이미 사용되었습니다.")
        binding=target.get("detection")
        if binding:
            choice=binding.get("voice_choice")
            await self.detections.current_choice(target["preset"],choice,hardware=True,step_id=target.get("step_id"))
            if choice["confirmation"]=="voice" and not from_voice:raise DomainError("마이크의 ‘로봇 실행’ 재확인이 필요합니다.")
        self.check_versions(target)
        if target["versions"]!=self.legacy.versions():raise DomainError("장비 또는 작업 설정이 변경되었습니다.",412)
        self.legacy.require_idle()
        if binding:binding["voice_choice"]["consumed"]=True
        target.update(session_id=target["status"]["session_id"],token=target["status"]["motion_token"],approved=True)
        self.legacy.runtimes[identifier]=target
        move=self.robot.picks.record(identifier,"scenario_running","프리셋 실행 준비 중",scenario=True,preset_id=target["preset_id"],
            preset_revision=target["preset_revision"],label=target["label"],step=0,total_steps=len(target["steps"]),steps=target["steps"],mode="transfer",hardware_test=True,
            detected=copy.deepcopy(target["detection"]["resolved"]) if target.get("detection") else None,recognition_prepare=target.get("recognition_prepare",False))
        self.robot.picks.task=asyncio.create_task(self.run(identifier))
        return move

    async def run(self,identifier):
        target=self.legacy.runtimes[identifier]
        try:
            binding=target.get("detection");grasped=False
            if binding:
                await self.detections.require_ready(target["preset"])
                await self.detections.revalidate(target["preset"],binding,approved=True)
            for step in target["steps"]:
                self.check_versions(target)
                await self.legacy.check_context(target)
                self.robot.picks.record(identifier,"scenario_running",step["title"],step=step["number"],step_id=step["id"])
                if binding and not grasped and step.get("object_role") in {"approach","descent"}:
                    await self.detections.revalidate(target["preset"],binding,approved=True)
                if step["kind"]=="wait":
                    deadline=time.monotonic()+step["seconds"]
                    while time.monotonic()<deadline:
                        await asyncio.sleep(min(.1,max(0,deadline-time.monotonic())))
                        if target["cancelled"]:raise DomainError("작업을 중단했습니다.")
                        self.check_versions(target)
                elif step["kind"]=="gripper":
                    feedback=await self.legacy.operation(identifier,"gripper",step["speed"],position=step["position"],contact=step["contact_ma"])
                    if binding and step.get("object_role")=="preopen":
                        width=self.robot.hand.width_at(feedback["position"])
                        if width is None or width+1e-8<binding["resolved"]["opening_mm"]:
                            raise DomainError("그리퍼가 대상에 필요한 벌림에 도달하지 못했습니다.")
                    if step.get("object_role")=="grip":grasped=True
                else:
                    await self.legacy.operation(identifier,step["kind"],step["speed"],step["target"],via_pose=step.get("via_pose"),expected_joints=step.get("expected_joints"),j1_only=step.get("j1_only",False))
            self.check_versions(target)
            if target["cancelled"]:raise DomainError("작업을 중단했습니다.")
            self.robot.picks.record(identifier,"completed",target["label"]+" 완료",step=len(target["steps"]))
        except Exception as exc:
            state="cancelled" if target["cancelled"] else "failed" if isinstance(exc,DomainError) else "unknown"
            self.robot.picks.record(identifier,state,str(exc) or "실행 결과 미확인")


def engine(request):return request.app.state.robot.presets


router=APIRouter(prefix="/presets")

@router.get("")
async def listing(request:Request):return engine(request).library.load()

@router.post("",dependencies=[Depends(local_json)],status_code=201)
async def create(body:MotionPreset,request:Request):return engine(request).save(body,True)

@router.get("/{identifier}")
async def get(identifier:str,request:Request):return engine(request).library.get(identifier)

@router.put("/{identifier}",dependencies=[Depends(local_json)])
async def save(identifier:str,body:MotionPreset,request:Request):
    if identifier!=body.id:raise DomainError("프리셋 ID가 다릅니다.")
    return engine(request).save(body)

@router.post("/{identifier}/copy",dependencies=[Depends(local_json)],status_code=201)
async def duplicate(identifier:str,body:CopyPreset,request:Request):
    e=engine(request);p=e.library.get(identifier)
    if p["revision"]!=body.revision:raise DomainError("최신 설정을 불러오세요.",412)
    p.update(id=uid(),revision=None,name=p["name"][:76]+" 복사본",voice_enabled=False,aliases=[])
    return e.save(MotionPreset.model_validate(p),True)

@router.post("/{identifier}/preview",dependencies=[Depends(local_json)])
async def simulation(identifier:str,body:PresetPreview,request:Request):
    e=engine(request);p=body.preset or e.library.get(identifier)
    if isinstance(p,MotionPreset) and p.id!=identifier:raise DomainError("프리셋 ID가 다릅니다.")
    p=p.model_dump() if isinstance(p,MotionPreset) else p
    binding=e.detections.bind(p,body.snapshot_id,body.candidate_id) if body.snapshot_id else None
    if binding:await e.detections.revalidate(p,binding)
    return e.compile(p,binding["resolved"] if binding else None)

@router.get("/sources/yolo")
async def yolo_catalog():return await asyncio.to_thread(read_yolo_catalog)

@router.post("/{identifier}/detections",dependencies=[Depends(local_json)])
async def detect(identifier:str,body:DetectionRequest,request:Request):
    e=engine(request);p=body.preset.model_dump() if body.preset else e.library.get(identifier)
    if p["id"]!=identifier:raise DomainError("프리셋 ID가 다릅니다.")
    if body.hardware and body.preset is not None:raise DomainError("실제 실행의 대상 확인에는 저장한 프리셋을 사용하세요.")
    if body.revision!=p["revision"]:raise DomainError("프리셋이 변경되었습니다. 다시 불러오세요.",412)
    return await e.detections.capture(p,hardware=body.hardware,reader=frame_reader(request))

@router.post("/{identifier}/recognition-preview",dependencies=[Depends(local_json)])
async def recognition(identifier:str,body:CopyPreset,request:Request):
    return await engine(request).preview(identifier,body.revision,recognition=True)

@router.post("/{identifier}/execution-preview",dependencies=[Depends(local_json)])
async def preview(identifier:str,body:PresetPreview,request:Request):
    if body.preset is not None:raise DomainError("실제 실행에는 저장된 프리셋만 사용할 수 있습니다.")
    return await engine(request).preview(identifier,body.revision,body.step_id,body.snapshot_id,body.candidate_id)

@router.post("/executions/approve",dependencies=[Depends(local_json)],status_code=202)
async def approve(body:Approval,request:Request):return await engine(request).approve(body.approval_id)
