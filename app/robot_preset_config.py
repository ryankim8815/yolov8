"""Independent motion presets and a pure compiler shared by playback and execution."""
import copy
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import uuid4, uuid5, NAMESPACE_URL

from pydantic import Field, FiniteFloat, model_validator

from .pick_plane import Input
from .robot_scenario_config import ScenarioInput, Six, Three, VirtualProduct, HandSpeed, check_joints, speed_for, simulation_box_pose
from .robot_grasp_pose import grasp_abc,tool_x
from .robot_scenario import approach_pose, compile_steps
from .store import DomainError, atomic_json
from .voice_commands import normalized

RESERVED = {normalized(s) for s in ("로봇 실행", "로봇 중단", "중단", "로봇 취소", "음성 대기 종료")}


def uid():
    return uuid4().hex


def child_id(parent,slot):
    return uuid5(NAMESPACE_URL,f"vision-lab-preset:{parent}:{slot}").hex


class PresetStep(Input):
    id: str = Field(default_factory=uid, min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    kind: Literal["movej", "movel", "movec", "gripper", "wait", "grasp", "place", "prepare", "checkpoint"]
    name: str = Field(default="", max_length=80)
    percent: int = Field(default=50, ge=10, le=100, multiple_of=10)
    acceleration: FiniteFloat = Field(default=5, gt=0, le=1_378_788)
    space: Literal["joint", "task"] = "joint"
    target: Six | None = None
    via_pose: Six | None = None
    source: Literal["explicit", "standby", "waypoint1", "waypoint2", "object_approach", "object", "box", "above_box"] = "explicit"
    reference_id: str | None = Field(default=None, max_length=64)
    j1_delta: FiniteFloat = Field(default=0, ge=-360, le=360)
    j1_only: bool = False
    opening_mm: FiniteFloat | None = Field(default=None, ge=0, le=1000)
    opening_source: Literal["explicit", "object", "idle"] = "explicit"
    contact: bool = False
    seconds: FiniteFloat = Field(default=1, ge=.1, le=600)
    # Preserve previously taught non-decimal percentages and acceleration exactly.
    legacy_speed: HandSpeed | None = None
    prepare_motion: Literal["movej", "movel", "movec"] = "movej"
    prepare_hand_speed: HandSpeed | None = None
    prepare_hand_id: str | None = Field(default=None,min_length=1,max_length=64,pattern=r"^[a-zA-Z0-9_-]+$")
    module_slot: int | None = Field(default=None,ge=0,le=4)
    module_id: str | None = Field(default=None,min_length=1,max_length=64,pattern=r'^[a-zA-Z0-9_-]+$')
    children: list["PresetStep"] = Field(default_factory=list, max_length=5)

    @model_validator(mode="after")
    def valid(self):
        if self.module_id and self.kind not in {'prepare','grasp','place'}:raise ValueError('모듈 정의는 모듈 동작에만 연결할 수 있습니다.')
        if self.kind == "gripper" and "acceleration" not in self.model_fields_set:
            self.acceleration = 3000
        sizes = {"grasp": 5, "place": 4}
        if self.kind in sizes and self.children:
            expected = ["movej", "gripper", "movel", "gripper", "movel"] if self.kind == "grasp" else ["movej", "movel", "gripper", "movel"]
            # The approach/above movement may also be a taught line or arc.
            if len(self.children) != sizes[self.kind] or any(c.kind != k for c,k in zip(self.children[1:], expected[1:])) or self.children[0].kind not in {"movej","movel","movec"}:
                raise ValueError("자동 묶음의 내부 순서는 변경할 수 없습니다.")
            slots=[c.module_slot for c in self.children]
            if all(slot is None for slot in slots):
                for index,child in enumerate(self.children):child.module_slot=index
            elif slots!=list(range(sizes[self.kind])):
                raise ValueError("모듈의 세부 단계 순서는 변경할 수 없습니다.")
        elif self.children:
            raise ValueError("자동 묶음에만 내부 단계가 있습니다.")
        if self.kind in {"movej","movel","movec","prepare"} and self.acceleration > 10:
            raise ValueError("팔 가속도 상한은 10입니다.")
        if self.kind == "movej" and self.space == "joint":
            check_joints(self.target)
        if self.legacy_speed and self.kind not in {"gripper","grasp","place"} and self.legacy_speed.acceleration > 10:
            raise ValueError("팔 가속도 상한은 10입니다.")
        return self


class PresetYolo(Input):
    model_version: str | None = Field(default=None, min_length=1, max_length=256)
    class_id: int | None = Field(default=None, ge=0)
    class_label: str = Field(default="", max_length=160)
    min_confidence: FiniteFloat = Field(default=.8, ge=0, le=1)
    selection: Literal["unique", "manual"] = "unique"


class MotionPreset(Input):
    id: str = Field(default_factory=uid, min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    name: str = Field(default="새 이동 경로", min_length=1, max_length=80)
    revision: str | None = Field(default=None, max_length=32)
    voice_enabled: bool = False
    aliases: list[str] = Field(default_factory=list, max_length=20)
    confirmation: Literal["screen", "voice"] = "screen"
    region: Literal["floor", "shelf"] = "floor"
    object_source: Literal["saved", "yolo"] = "saved"
    yolo: PresetYolo = Field(default_factory=PresetYolo)
    # None preserves existing saved-path defaults / legacy taught YOLO orientation.
    grasp_abc: dict[Literal["floor","shelf"],Three|None] = Field(default_factory=lambda:dict(floor=None,shelf=None))
    simulation_objects: dict[Literal["floor","shelf"],VirtualProduct|None] = Field(default_factory=lambda:dict(floor=None,shelf=None))
    context: ScenarioInput = Field(default_factory=ScenarioInput)
    box_pose: Six | None = None
    box_size: list[FiniteFloat] = Field(default_factory=lambda:[400,300,250], min_length=3, max_length=3)
    box_center: list[FiniteFloat] = Field(default_factory=lambda:[500,0,0], min_length=3, max_length=3)
    range_start: str | None = None
    range_end: str | None = None
    steps: list[PresetStep] = Field(default_factory=lambda:[PresetStep(kind="movej", name="관절 이동")], min_length=1, max_length=100)

    @model_validator(mode="after")
    def valid(self):
        self.name=self.name.strip()
        if not self.name:raise ValueError("프리셋 이름을 입력하세요.")
        self.aliases=[a.strip() for a in self.aliases]
        words=[normalized(a) for a in self.aliases]
        if any(not w or len(a)>120 or w in RESERVED for a,w in zip(self.aliases,words)):
            raise ValueError("명령은 120자 이내로 입력하고 실행·취소·중단 예약어를 제외하세요.")
        if len(set(words))!=len(words):raise ValueError("같은 음성 명령이 중복되었습니다.")
        if self.voice_enabled and not words:raise ValueError("음성 명령을 한 개 이상 등록하세요.")
        ids=[s.id for s in self.steps]
        all_ids=ids+[c.id for s in self.steps for c in s.children]
        all_ids += [child_id(s.id,i) for s in self.steps if s.kind in {"grasp","place"} and not s.children for i in range(5 if s.kind=="grasp" else 4)]
        all_ids += [s.prepare_hand_id or child_id(s.id,"hand") for s in self.steps if s.kind=="prepare"]
        if len(set(all_ids))!=len(all_ids):raise ValueError("단계 ID가 중복되었습니다.")
        for s in self.steps:
            if s.module_slot is not None:raise ValueError("모듈의 세부 단계는 개별 동작으로 분리할 수 없습니다.")
            if s.reference_id and s.reference_id not in ids:raise ValueError("참조한 단계가 삭제되었습니다.")
        if bool(self.range_start)!=bool(self.range_end):raise ValueError("시작과 종료 단계를 함께 지정하세요.")
        if self.range_start and (self.range_start not in ids or self.range_end not in ids or ids.index(self.range_start)>ids.index(self.range_end)):
            raise ValueError("실행 구간은 묶음 전체를 포함하는 순서로 지정하세요.")
        count=sum(5 if s.kind=="grasp" else 4 if s.kind=="place" else 2 if s.kind=="prepare" else 0 if s.kind=="checkpoint" else 1 for s in self.steps)
        if not 1<=count<=100:raise ValueError("실행 단계는 1~100개여야 합니다.")
        if self.range_start and all(s.kind=="checkpoint" for s in self.steps[ids.index(self.range_start):ids.index(self.range_end)+1]):
            raise ValueError("실행 구간에 동작이 한 개 이상 있어야 합니다.")
        if any(v<=0 for v in self.box_size):raise ValueError("박스 크기는 양수여야 합니다.")
        if set(self.grasp_abc)!={"floor","shelf"}:raise ValueError("바닥·선반 파지 자세를 모두 제공하세요.")
        if set(self.simulation_objects)!={"floor","shelf"}:raise ValueError("바닥·선반 시뮬레이션 객체 설정을 모두 제공하세요.")
        if any(abs(v)>1e6 for abc in self.grasp_abc.values() if abc for v in abc):raise ValueError("파지 자세 각도의 단위를 확인하세요.")
        if self.object_source=="yolo" and sum(s.kind=="grasp" for s in self.steps)>1:
            raise ValueError("YOLO 프리셋은 자동 파지 묶음을 한 개만 연결할 수 있습니다.")
        # The original 17-stage template reserves preparation/return for standby.
        # Transfers are independent taught targets, never live references to another row.
        if len(self.steps)==10 and [self.steps[i].kind for i in (0,1,2,5,9)]==["prepare","checkpoint","grasp","place","gripper"] and all(self.steps[i].kind in {"movej","movel","movec"} for i in (3,4,6,7,8)):
            self.steps[8].source="standby";self.steps[8].space="joint";self.steps[8].reference_id=None;self.steps[8].target=None;self.steps[8].j1_only=False
            self.steps[9].source="standby";self.steps[9].opening_source="idle";self.steps[9].opening_mm=None;self.steps[9].contact=False
        elif len(self.steps)==13 and [self.steps[i].kind for i in (0,1,2,7,12)]==["prepare","checkpoint","grasp","gripper","gripper"] and all(self.steps[i].kind in {"movej","movel","movec"} for i in (3,4,5,6,8,9,10,11)):
            for index,source in ((5,"above_box"),(6,"box"),(8,"above_box"),(11,"standby")):
                self.steps[index].source=source;self.steps[index].space="joint" if source=="standby" else "task";self.steps[index].target=None;self.steps[index].reference_id=None;self.steps[index].j1_only=False
            self.steps[7].source="box";self.steps[7].opening_source="object";self.steps[7].contact=False
            self.steps[12].source="standby";self.steps[12].opening_source="idle";self.steps[12].opening_mm=None;self.steps[12].contact=False
        for s in self.steps:
            if s.kind=="prepare":s.source="standby";s.target=None;s.reference_id=None;s.space="joint";s.j1_only=False
        old={s.id:s.model_copy(deep=True) for s in self.steps}
        def saved_target(s,trail=()):
            if s.id in trail:raise ValueError("단계 참조가 순환합니다.")
            if s.reference_id:
                other=old[s.reference_id]
                if other.space!="joint":raise ValueError("관절 참조는 관절 목표 단계만 사용할 수 있습니다.")
                value=saved_target(other,(*trail,s.id))
                return [value[0]+s.j1_delta,*value[1:]] if value else None
            if s.source=="standby":return self.context.standby_joints
            if s.source in {"waypoint1","waypoint2"}:
                value=self.context.waypoint1_joints
                return [value[0]+self.context.turn_degrees,*value[1:]] if value and s.source=="waypoint2" else value
            return s.target if s.source=="explicit" else None
        for s in self.steps:
            if s.reference_id or s.source in {"waypoint1","waypoint2"}:
                s.target=copy.deepcopy(saved_target(old[s.id]));s.source="explicit";s.reference_id=None;s.j1_delta=0;s.j1_only=False
                if s.space=="joint":check_joints(s.target)
        # Standby movement + opening restore is one reusable two-stage module.
        # Preserve physical step IDs and speeds while removing partial-module ranges.
        def module_range(members,module_id):
            if (self.range_start in members and self.range_start!=members[0]) or (self.range_end in members and self.range_end!=members[-1]):
                raise ValueError("실행 구간은 모듈의 세부 단계가 아닌 모듈 전체를 선택하세요.")
            if self.range_start in members:self.range_start=module_id
            if self.range_end in members:self.range_end=module_id
        modules=[];index=0
        while index<len(self.steps):
            s=self.steps[index];tail=self.steps[index+1:]
            if s.kind in {"movej","movel","movec"} and s.source=="standby" and tail and tail[0].kind=="gripper" and tail[0].opening_source=="idle" and not tail[0].contact:
                hand=tail[0];module_range([s.id,hand.id],s.id)
                modules.append(s.model_copy(update=dict(kind="prepare",prepare_motion=s.kind,prepare_hand_id=hand.id,prepare_hand_speed=HandSpeed(**physical_speed(hand,True)),children=[])))
                index+=2;continue
            group=self.steps[index:index+4]
            if len(group)==4 and [c.source for c in group]==["above_box","box","box","above_box"] and group[0].kind in {"movej","movel","movec"} and [c.kind for c in group[1:]]==["movel","gripper","movel"]:
                identifier=child_id(s.id,"place-module");module_range([c.id for c in group],identifier)
                modules.append(PresetStep(id=identifier,kind="place",name="박스 놓기",children=group,percent=s.percent,acceleration=s.acceleration))
                index+=4;continue
            modules.append(s);index+=1
        self.steps=modules
        all_ids=[s.id for s in self.steps]+[c.id for s in self.steps for c in s.children]
        all_ids += [child_id(s.id,i) for s in self.steps if s.kind in {"grasp","place"} and not s.children for i in range(5 if s.kind=="grasp" else 4)]
        all_ids += [s.prepare_hand_id or child_id(s.id,"hand") for s in self.steps if s.kind=="prepare"]
        if len(set(all_ids))!=len(all_ids):raise ValueError("모듈과 단계 ID가 중복되었습니다.")
        return self


def physical_speed(step, hand=False):
    return step.legacy_speed.model_dump() if step.legacy_speed else dict(speed=step.percent/10, acceleration=step.acceleration)


def compile_preset(preset, hand, floor_z=0, *, selected_range=True, detected=None,module_settings=None):
    """No SDK traffic; incomplete drafts return diagnostics rather than guessed targets."""
    p=MotionPreset.model_validate(preset.model_dump() if isinstance(preset,MotionPreset) else preset)
    cfg=p.context.model_dump();product=copy.deepcopy(cfg["virtual"][p.region]);errors=[]
    pose=[*product["center_base_mm"],*grasp_abc(p.model_dump())]
    approach=approach_pose(cfg,p.region,pose)
    width=(sum(abs(a)*s for a,s in zip(tool_x(pose[3:]),product["size_mm"])) if p.grasp_abc[p.region] is not None else product["size_mm"][0 if p.region=="floor" else 1]);opening=width+10
    if p.object_source=="yolo":
        if not any(s.kind=="grasp" for s in p.steps):errors.append("자동 파지 묶음을 한 개 추가하세요.")
        if detected:
            pose=copy.deepcopy(detected["pose"]);width=detected["width_mm"];opening=detected["opening_mm"]
            product.update(center_base_mm=pose[:3],size_mm=copy.deepcopy(detected["size_mm"]))
            approach=approach_pose(cfg,p.region,pose,detected["normal"])
        else:
            pose=approach=None;width=opening=None;product["center_base_mm"]=None
            errors.append("YOLO 대상을 확인하고 선택한 뒤 경로를 계산하세요.")
    idle=cfg["standby_opening_mm"] or max((x["width_mm"] for x in hand.table["points"]),default=80)
    by_id={s.id:s for s in p.steps};targets={}
    def resolve(s, trail=()):
        if s.id in targets:return targets[s.id]
        if s.id in trail:raise DomainError("단계 참조가 순환합니다.")
        if s.reference_id:
            other=by_id[s.reference_id]
            if other.space!="joint":raise DomainError("관절 참조는 관절 목표 단계만 사용할 수 있습니다.")
            value=resolve(other,(*trail,s.id))
            value=([value[0]+s.j1_delta,*value[1:]] if value else None)
        else:
            w=cfg["waypoint1_joints"]
            value={"explicit":s.target,"standby":cfg["standby_joints"],"waypoint1":w,
                   "waypoint2":[w[0]+cfg["turn_degrees"],*w[1:]] if w else None,
                   "object":pose,"object_approach":approach,"box":p.box_pose,
                   "above_box":[p.box_pose[0],p.box_pose[1],p.box_pose[2]+cfg["box_clearance_mm"],*p.box_pose[3:]] if p.box_pose else None}[s.source]
        if value and s.space=="joint":check_joints(value)
        targets[s.id]=copy.deepcopy(value);return targets[s.id]
    nodes=p.steps
    if selected_range and p.range_start:
        ids=[s.id for s in nodes];nodes=nodes[ids.index(p.range_start):ids.index(p.range_end)+1]
    result=[];last_opening=opening
    def append(s, group=None, forced_source=None, hand_width=None, forced_contact=None,forced_target=None):
        nonlocal last_opening
        kind=s.kind
        if kind=="checkpoint":return
        if kind=="prepare":
            settings=(module_settings or {}).get(s.id,{}).get('settings')
            goal=settings['joints'] if settings else cfg['standby_joints']
            standby_width=(settings['opening_mm'] or max((x['width_mm'] for x in hand.table['points']),default=80)) if settings else idle
            movement=s.model_copy(update={"kind":s.prepare_motion,"source":"standby","target":None,"reference_id":None,"space":"joint","j1_only":False})
            append(movement, s.id,forced_target=goal)
            h=PresetStep(id=s.prepare_hand_id or child_id(s.id,"hand"),kind="gripper",name="대기 벌림 복원",opening_mm=standby_width,percent=s.percent,acceleration=3000,legacy_speed=s.prepare_hand_speed)
            append(h,s.id);return
        if kind in {"grasp","place"}:
            module_pose,module_approach,module_width,module_opening=pose,approach,width,opening
            settings=(module_settings or {}).get(s.id,{}).get('settings')
            if kind=='grasp' and settings:
                module_cfg=copy.deepcopy(cfg);module_cfg['approaches']=settings['approaches']
                if pose is not None:
                    abc=settings['grasp_abc'][p.region]
                    if abc is None and not detected:abc=grasp_abc({**p.model_dump(),'grasp_abc':settings['grasp_abc']})
                    module_pose=[*pose[:3],*(abc or pose[3:])]
                    module_approach=approach_pose(module_cfg,p.region,module_pose,detected['normal'] if detected else None)
                    if not detected:
                        module_width=sum(abs(a)*size for a,size in zip(tool_x(module_pose[3:]),product['size_mm'])) if settings['grasp_abc'][p.region] is not None else product['size_mm'][0 if p.region=='floor' else 1]
                        module_opening=module_width+10
            if kind=='grasp':last_opening=module_opening
            specs=([("movej","상품 접근 위치","object_approach",None,False),("gripper","권장 폭으로 벌리기",None,module_opening,False),
                    ("movel","파지점으로 접근","object",None,False),("gripper","접촉 확인·파지 유지",None,None,True),
                    ("movel","접근 위치로 후퇴","object_approach",None,False)] if kind=="grasp" else
                   [("movej","박스 위 위치","above_box",None,False),("movel","놓기 위치로 하강","box",None,False),
                    ("gripper","파지 전 벌림으로 개방",None,last_opening,False),("movel","박스 위로 상승","above_box",None,False)])
            for i,(k,title,source,w,contact) in enumerate(specs):
                child=(s.children[i] if s.children else PresetStep(id=child_id(s.id,i),kind=k,name=title,percent=s.percent,acceleration=3000 if k=="gripper" else s.acceleration))
                # Automatic groups never accept client-supplied Cartesian/joint targets.
                child=child.model_copy(update={"source":source or "explicit","space":"task","target":None,"reference_id":None})
                target={'object':module_pose,'object_approach':module_approach}.get(source) if kind=='grasp' else None
                append(child,s.id,source,w,contact,forced_target=target)
                if kind=="grasp":
                    result[-1]["object_role"]=("approach","preopen","descent","grip","retreat")[i]
                    if contact:result[-1]['object_width_mm']=module_width
            return
        group_kind=by_id[group].kind if group else None
        calculation=("standby" if group_kind=="prepare" or s.source=="standby" or kind=="gripper" and s.opening_source=="idle" else
                     "object" if group_kind=="grasp" or s.source in {"object","object_approach"} else
                     "box" if group_kind=="place" or s.source in {"box","above_box"} else
                     "object" if kind=="gripper" and s.opening_source=="object" else None)
        out=dict(id=s.id,group_id=group,kind={"movej":"joint","movel":"line","movec":"circle"}.get(kind,kind),calculation_source=calculation,computed=bool(calculation),
                 motion=kind if kind in {"movej","movel","movec"} else None,title=s.name or kind,speed=physical_speed(s,kind=="gripper"))
        if kind in {"movej","movel","movec"}:
            target=forced_target if forced_target is not None else resolve(s)
            if target is None:errors.append((s.name or kind)+"의 목표 좌표를 입력하세요.")
            out.update(target=target,space=s.space,via_pose=s.via_pose)
            out["j1_only"]=s.j1_only
            if kind=="movec" and s.via_pose is None:errors.append((s.name or kind)+"의 원호 경유 TCP를 입력하세요.")
        elif kind=="gripper":
            contact=s.contact if forced_contact is None else forced_contact
            w=hand_width if hand_width is not None else s.opening_mm
            if hand_width is None and s.opening_source!="explicit":w=opening if s.opening_source=="object" else idle
            if not contact and w is None:errors.append((s.name or kind)+"의 벌림을 입력하세요.")
            out.update(opening_mm=w,contact=contact)
        else:out["seconds"]=s.seconds
        result.append(out)
    try:
        for s in nodes:append(s)
    except (DomainError,ValueError) as exc:errors.append(str(exc))
    for i,s in enumerate(result):s["number"]=i+1
    return dict(simulation_only=True,preset_id=p.id,revision=p.revision,name=p.name,generic=True,steps=result,errors=list(dict.fromkeys(errors)),
                config=cfg,product=product,pose=pose,approach=approach,box_pose=p.box_pose,
                box=dict(size_mm=p.box_size,center_base_mm=p.box_center),floor_z_mm=floor_z,
                opening_mm=opening,width_mm=width,idle_opening_mm=idle,object_source=p.object_source,
                detected=copy.deepcopy(detected))


def compile_simulation(preset,hand,floor_z=0,*,box=None,defaults=False,simulation_object=True,detected=None,module_settings=None):
    """Explicit preview-only override. Hardware always calls compile_preset."""
    p=MotionPreset.model_validate(preset.model_dump() if isinstance(preset,MotionPreset) else preset)
    draft=p.model_copy(deep=True);virtual_defaults=[]
    if box:
        draft.box_size=copy.deepcopy(box["size_mm"]);draft.box_center=copy.deepcopy(box["center_base_mm"])
    obj=p.simulation_objects[p.region] if simulation_object else None
    if obj is not None:
        draft.object_source="saved";draft.context.virtual[p.region]=obj.model_copy(deep=True)
    if defaults:
        def flatten(steps):
            return [item for step in steps for item in [step,*flatten(step.children)]]
        roots=draft.steps
        if draft.range_start:
            ids=[step.id for step in roots];roots=roots[ids.index(draft.range_start):ids.index(draft.range_end)+1]
        nodes=flatten(roots);by_id={step.id:step for step in flatten(draft.steps)}
        for step in list(nodes):
            seen=set()
            while step.reference_id and step.reference_id not in seen:
                seen.add(step.reference_id);step=by_id[step.reference_id];nodes.append(step)
        if draft.box_pose is None and any(step.kind=="place" or step.source in {"box","above_box"} for step in nodes):
            geometry=dict(size_mm=draft.box_size,center_base_mm=draft.box_center)
            draft.box_pose=simulation_box_pose(geometry)
            draft.context.box_clearance_mm=max(draft.context.box_clearance_mm,draft.box_center[2]+draft.box_size[2]+50-draft.box_pose[2])
            virtual_defaults.append(dict(field="box_pose",label="박스 놓기 TCP",value=list(draft.box_pose)))
    recipe=compile_preset(draft,hand,floor_z,detected=detected,module_settings=module_settings)
    recipe["simulation_defaults"]=virtual_defaults
    if box:recipe.update(box_source="parcel_box",box_revision=box.get("revision"))
    if obj is not None:recipe.update(example=True,name="모의 객체 · "+p.name,object_source=p.object_source)
    return recipe


class PresetLibrary:
    def __init__(self,directory,robot):
        self.path=Path(directory)/"motion-presets.json";self.robot=robot;self.value=None

    def load(self):
        if self.value is not None:return self.value
        if self.path.exists():
            data=json.loads(self.path.read_text())
            if data.get("schema_version",1)<2:
                self.backup("ui-cleanup")
                data=self.import_saved_locations(data)
            if data.get("schema_version",1)<3:
                self.backup("manual-stages-v3")
                normalized=[];changed=[]
                for previous in data["presets"]:
                    p=MotionPreset.model_validate(previous).model_dump()
                    if p!=previous:p["revision"]=uid();changed.append(p["id"])
                    normalized.append(p)
                data.update(schema_version=3,presets=normalized,manual_stage_migration=dict(version=3,changed_presets=changed))
                atomic_json(self.path,data)
            if data.get("schema_version",1)<4:
                self.backup("modules-v4")
                normalized=[];changed=[]
                for previous in data["presets"]:
                    p=MotionPreset.model_validate(previous).model_dump()
                    if p!=previous:p["revision"]=uid();changed.append(p["id"])
                    normalized.append(p)
                data.update(schema_version=4,presets=normalized,module_migration=dict(version=4,changed_presets=changed))
                atomic_json(self.path,data)
            else:data["presets"]=[MotionPreset.model_validate(p).model_dump() for p in data["presets"]]
            self.value=data;return data
        self.backup("preset-migration")
        cfg=copy.deepcopy(self.robot.scenario.config.value);box=self.robot.work_points.points["box"]["pose"]
        p=MotionPreset(name="기존 이동 경로",context=ScenarioInput.model_validate(cfg),box_pose=box,
                       box_size=self.robot.parcel_box.value["size_mm"],box_center=self.robot.parcel_box.value["center_base_mm"],steps=self.migrate(cfg))
        p.revision=uid();self.value=self.import_saved_locations(dict(schema_version=1,presets=[p.model_dump()]));self.value["schema_version"]=4;atomic_json(self.path,self.value)
        return self.value

    def backup(self,prefix):
        backup=self.path.parent/"backups"/(prefix+"-"+datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")+"-"+uid()[:8])
        backup.mkdir(parents=True)
        for source in self.path.parent.glob("*.json"):shutil.copy2(source,backup/source.name)
        return backup

    def import_saved_locations(self,data):
        """Preserve old editors as independent, non-voice presets; never retarget a saved route."""
        data=copy.deepcopy(data);imports=[]
        cfg=ScenarioInput.model_validate(self.robot.scenario.config.value)
        common=dict(context=cfg,box_size=self.robot.parcel_box.value["size_mm"],box_center=self.robot.parcel_box.value["center_base_mm"])
        def add(key,name,step,revision):
            identifier=child_id("ui-cleanup-v2",key)
            while any(p["id"]==identifier for p in data["presets"]):identifier=uid()
            p=MotionPreset(id=identifier,name=name,steps=[step],revision=uid(),**common)
            data["presets"].append(p.model_dump())
            imports.append(dict(source=key,source_revision=revision,preset_id=identifier))
        for key,label in (("waypoint","경유점"),("box","박스 놓기 TCP"),("shipping_label","송장 위치")):
            point=self.robot.work_points.points[key]
            if point.get("pose") is not None:
                add("point-"+key,"이관 작업점 · "+label,PresetStep(kind="movej",name=label,space="task",target=point["pose"],percent=50),point.get("revision"))
        for pose in self.robot.pose_tests.data["poses"]:
            if pose.get("angles") is not None:
                name="저장 자세 "+str(pose["slot"])
                add("pose-"+str(pose["slot"]),name,PresetStep(kind="movej",name=name,target=pose["angles"],percent=100,acceleration=10),pose.get("revision"))
        data.update(schema_version=2,ui_migration=dict(version=2,imported=imports))
        return data

    def migrate(self,cfg):
        result=[];raw={}
        source_map={1:"standby",3:"object_approach",5:"object",7:"object_approach",8:"waypoint1",9:"waypoint2",10:"above_box",11:"box",13:"above_box",14:"waypoint2",15:"waypoint1",16:"standby"}
        for old in compile_steps(cfg,[0,0,0,0,180,0],[0,0,100,0,180,0],None,50,80):
            n=old["number"];kind=old.get("motion") or ("checkpoint" if n==2 else "gripper")
            speed=speed_for(cfg,n,"gripper" if kind=="gripper" else "joint") if n!=2 else dict(speed=5,acceleration=5)
            source=source_map.get(n,"explicit");target=None;space=old.get("space","joint")
            if old.get("joint_override"):source="explicit";target=old["target"];space="joint"
            s=PresetStep(kind=kind,name=old["title"],source=source,target=target,space=space,via_pose=old.get("via_pose"),
                percent=max(10,min(100,int(round(speed["speed"]))*10)),acceleration=speed["acceleration"],legacy_speed=HandSpeed(**speed),
                opening_mm=None,contact=n==6)
            s.j1_only=old.get("j1_only",False)
            raw[n]=s
        # Preparation is kept as a group so the taught motion and hand speed both survive.
        raw[1].prepare_motion=raw[1].kind
        raw[1].prepare_hand_speed=HandSpeed(**cfg["profiles"][cfg["stages"]["1"]["profile"]]["gripper"])
        raw[1].kind="prepare"
        raw[1].children=[]
        raw[17].opening_source="idle"
        raw[12].opening_source="object"
        grouped_place=not any(cfg["stages"][str(n)].get("target_joints") is not None for n in (10,11,13))
        for n in (9,14,15):
            # Legacy returns use the saved waypoint, not a manual override on an earlier row.
            origin=8 if n in {9,15} else 9
            if raw[n].target is None and raw[origin].target is None:
                raw[n].reference_id=raw[origin].id
                raw[n].j1_delta=cfg["turn_degrees"] if n==9 else 0
        for n in range(1,18):
            if n==3:result.append(PresetStep(kind="grasp",name="자동 파지",children=[raw[i] for i in range(3,8)]))
            elif n==10 and grouped_place:result.append(PresetStep(kind="place",name="박스 놓기",children=[raw[i] for i in range(10,14)]))
            elif n not in set(range(3,8)) and (n not in range(10,14) or not grouped_place):result.append(raw[n])
        return result

    def get(self,identifier):
        p=next((p for p in self.load()["presets"] if p["id"]==identifier),None)
        if p is None:raise DomainError("프리셋을 찾을 수 없습니다.",404)
        return copy.deepcopy(p)

    def save(self,preset,create=False):
        data=copy.deepcopy(self.load());old=next((p for p in data["presets"] if p["id"]==preset.id),None)
        if create and old:raise DomainError("이미 등록된 프리셋입니다.")
        if not create and (not old or preset.revision!=old["revision"]):raise DomainError("다른 화면에서 변경되었습니다. 최신 프리셋을 불러오세요.",412)
        previous={s["id"]:s for s in old["steps"]} if old else {}
        for step in preset.steps:
            prior=previous.get(step.id)
            if prior and prior["kind"] in {"prepare","grasp","place"}:
                if step.kind!=prior["kind"]:raise DomainError("기존 모듈의 유형은 변경할 수 없습니다. 모듈 전체를 삭제하거나 추가하세요.",422)
                expected=[c["id"] for c in prior.get("children",[])] or [child_id(step.id,i) for i in range(5 if step.kind=="grasp" else 4)]
                if (step.kind in {"grasp","place"} and step.children and [c.id for c in step.children]!=expected) or (prior.get("children") and not step.children):
                    raise DomainError("모듈의 세부 단계 순서는 변경할 수 없습니다.",422)
        words={normalized(a) for a in preset.aliases}
        if any(words & {normalized(a) for a in p["aliases"]} for p in data["presets"] if p["id"]!=preset.id):
            raise DomainError("다른 프리셋에 같은 음성 명령이 등록되어 있습니다.")
        p=preset.model_dump();p["revision"]=uid()
        data["presets"]=[p if item["id"]==p["id"] else item for item in data["presets"]] if old else [*data["presets"],p]
        atomic_json(self.path,data);self.value=data;return copy.deepcopy(p)
