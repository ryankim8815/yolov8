"""Versioned reusable module definitions. Built-ins are editable, never removable."""
import copy
import json
from pathlib import Path
from typing import Literal

from fastapi import APIRouter,Depends,Request
from pydantic import Field,model_validator

from .pick_plane import Input
from .robot_access_protocol import local_json
from .robot_preset_config import MotionPreset,uid
from .robot_scenario_config import Six,Three,Approach,check_joints
from .store import DomainError,atomic_json,now

DEFAULTS={'prepare':('builtin-standby','대기 자세'),'grasp':('builtin-grasp','파지 단계(YOLOv8 제공 좌표 활용 단계)'),'place':('builtin-place','박스 위치 기반 단계')}


class StandbySettings(Input):
    joints: Six=Field(default_factory=lambda:[0,0,90,0,90,0])
    opening_mm: float|None=Field(default=None,gt=0,le=1000)
    @model_validator(mode='after')
    def valid(self):check_joints(self.joints);return self


class GraspSettings(Input):
    approaches: dict[Literal['floor','shelf'],Approach]=Field(default_factory=lambda:dict(floor=Approach(),shelf=Approach()))
    grasp_abc: dict[Literal['floor','shelf'],Three|None]=Field(default_factory=lambda:dict(floor=None,shelf=None))
    @model_validator(mode='after')
    def valid(self):
        if set(self.approaches)!={'floor','shelf'} or set(self.grasp_abc)!={'floor','shelf'}:raise ValueError('바닥·선반 설정을 모두 제공하세요.')
        return self


class PlaceSettings(Input):pass


class ModuleInput(Input):
    name: str=Field(min_length=1,max_length=80)
    kind: Literal['prepare','grasp','place']
    description: str=Field(default='',max_length=500)
    default_percent: int=Field(default=50,ge=10,le=100,multiple_of=10)
    settings: dict=Field(default_factory=dict)
    revision: str|None=Field(default=None,max_length=32)
    @model_validator(mode='after')
    def valid(self):
        self.name=self.name.strip()
        if not self.name:raise ValueError('모듈 이름을 입력하세요.')
        model={'prepare':StandbySettings,'grasp':GraspSettings,'place':PlaceSettings}[self.kind]
        self.settings=model.model_validate(self.settings).model_dump();return self


class ModuleRevision(Input):revision:str


def legacy_settings(kind,p):
    if kind=='prepare':return dict(joints=p['context']['standby_joints'],opening_mm=p['context']['standby_opening_mm'])
    if kind=='grasp':return dict(approaches=p['context']['approaches'],grasp_abc=p['grasp_abc'])
    return {}


class ModuleLibrary:
    def __init__(self,directory,engine):
        self.path=Path(directory)/'module-library.json';self.engine=engine;self.value=None

    def load(self):
        if self.value is not None:return self.value
        library=self.engine.library.load();seed=library['presets'][0]
        data=json.loads(self.path.read_text()) if self.path.exists() else dict(revision=uid(),modules=[])
        for kind,(identifier,name) in DEFAULTS.items():
            if not any(m['id']==identifier for m in data['modules']):
                data['modules'].append(dict(id=identifier,builtin=True,revision=uid(),updated_at=now(),**ModuleInput(name=name,kind=kind,settings=legacy_settings(kind,seed)).model_dump(exclude={'revision'})))
        self.value=data
        if library.get('schema_version',1)<5:
            self.engine.library.backup('module-library-v5')
            changed=copy.deepcopy(library)
            for p in changed['presets']:
                for step in p['steps']:
                    if step['kind'] not in DEFAULTS:continue
                    settings=legacy_settings(step['kind'],p)
                    match=next((m for m in data['modules'] if m['kind']==step['kind'] and m['settings']==settings),None)
                    if match is None:
                        match=dict(id=uid(),builtin=False,revision=uid(),updated_at=now(),**ModuleInput(name=('이관 · '+p['name']+' · '+DEFAULTS[step['kind']][1])[:80],kind=step['kind'],settings=settings).model_dump(exclude={'revision'}));data['modules'].append(match)
                    step['module_id']=match['id']
                p['revision']=uid()
            changed['schema_version']=5;changed['module_library_migration']=dict(version=5)
            # A unique existing taught drop point can become the shared goal without guessing.
            poses=[]
            for p in library['presets']:
                if p.get('box_pose') is not None and any(s['kind']=='place' or s['source'] in {'box','above_box'} for s in p['steps']) and p['box_pose'] not in poses:poses.append(p['box_pose'])
            parcel=self.engine.robot.parcel_box
            if parcel.value.get('tcp_pose') is None and len(poses)==1:
                from .robot_work_points import ParcelBoxInput
                parcel.save(ParcelBoxInput(**{k:parcel.value[k] for k in ('revision','size_mm','center_base_mm')},tcp_pose=poses[0],clearance_mm=seed['context']['box_clearance_mm']))
            if len(poses)>1:data['migration_notice']='기존 프리셋의 놓기 TCP가 서로 다릅니다. 택배 박스 설정에서 공통 놓기 TCP를 입력하세요. 이전 좌표는 백업에 보존했습니다.'
            atomic_json(self.path,data);atomic_json(self.engine.library.path,changed);self.engine.library.value=changed
        elif not self.path.exists():atomic_json(self.path,data)
        return data

    def get(self,identifier):
        module=next((m for m in self.load()['modules'] if m['id']==identifier),None)
        if module is None:raise DomainError('모듈을 찾을 수 없습니다.',404)
        return copy.deepcopy(module)

    def uses(self,identifier):
        return [dict(id=p['id'],name=p['name'],instances=sum(s.get('module_id')==identifier for s in p['steps'])) for p in self.engine.library.load()['presets'] if any(s.get('module_id')==identifier for s in p['steps'])]

    def public(self,module):return {**copy.deepcopy(module),'used_by':self.uses(module['id'])}
    def listing(self):return {**self.load(),'migration_notice':self.load().get('migration_notice','') if self.engine.robot.parcel_box.value.get('tcp_pose') is None else '', 'modules':[self.public(m) for m in self.load()['modules']]}

    def save(self,body,identifier=None):
        self.engine.legacy.require_idle();data=copy.deepcopy(self.load());old=self.get(identifier) if identifier else None
        if old and body.revision!=old['revision']:raise DomainError('다른 화면에서 모듈을 수정했습니다. 최신 모듈을 불러오세요.',412)
        if old and body.kind!=old['kind']:raise DomainError('모듈 유형은 변경할 수 없습니다. 다른 유형은 새 모듈로 추가하세요.',422)
        value=dict(id=identifier or uid(),builtin=old['builtin'] if old else False,revision=uid(),updated_at=now(),**body.model_dump(exclude={'revision'}))
        data['modules']=[value if m['id']==identifier else m for m in data['modules']] if old else [*data['modules'],value]
        data['revision']=uid();atomic_json(self.path,data);self.value=data
        if self.engine.voice:self.engine.voice.invalidate('모듈 변경으로 실행 확인을 취소했습니다.')
        return self.public(value)

    def delete(self,identifier,revision):
        self.engine.legacy.require_idle();module=self.get(identifier)
        if module['builtin'] or identifier in {v[0] for v in DEFAULTS.values()}:raise DomainError('기본 모듈은 삭제할 수 없습니다. 수정만 가능합니다.',409)
        if revision!=module['revision']:raise DomainError('모듈이 변경되었습니다. 최신 설정을 불러오세요.',412)
        if self.uses(identifier):raise DomainError('프리셋에서 사용 중인 모듈입니다. 경로에서 제거한 뒤 삭제하세요.',409)
        data=copy.deepcopy(self.load());data['modules']=[m for m in data['modules'] if m['id']!=identifier];data['revision']=uid()
        atomic_json(self.path,data);self.value=data
        if self.engine.voice:self.engine.voice.invalidate('모듈 삭제로 실행 확인을 취소했습니다.')
        return dict(deleted=True,id=identifier)

    def bind(self,p):
        self.load();bindings={}
        for step in p['steps']:
            if step['kind'] not in DEFAULTS:continue
            module=self.get(step.get('module_id') or DEFAULTS[step['kind']][0])
            if module['kind']!=step['kind']:raise DomainError('경로 모듈과 모듈 정의의 유형이 다릅니다.',422)
            step['module_id']=module['id'];bindings[step['id']]=module
        return bindings


router=APIRouter(prefix='/modules')
def library(request):return request.app.state.robot.presets.modules
@router.get('')
async def listing(request:Request):return library(request).listing()
@router.get('/{identifier}')
async def get(identifier:str,request:Request):return library(request).public(library(request).get(identifier))
@router.post('',dependencies=[Depends(local_json)],status_code=201)
async def create(body:ModuleInput,request:Request):return library(request).save(body)
@router.put('/{identifier}',dependencies=[Depends(local_json)])
async def update(identifier:str,body:ModuleInput,request:Request):return library(request).save(body,identifier)
@router.delete('/{identifier}',dependencies=[Depends(local_json)])
async def delete(identifier:str,body:ModuleRevision,request:Request):return library(request).delete(identifier,body.revision)
