"""Consume final transcripts from the Mac audio owner; browser text tests cannot approve hardware."""
import asyncio
import copy
import json
import os
import time
from contextlib import suppress
from http.client import HTTPConnection
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from pydantic import Field

from .pick_plane import Input
from .robot_access_protocol import local_json
from .robot_preset_config import uid
from .robot_preset_class import catalog_signature, match_class
from .robot_preset_detection import signature
from .store import DomainError
from .voice_commands import normalized


def native_voice(action, after=0, *, session_id=None):
    host="host.docker.internal" if os.getenv("ROBOT_BRIDGE_NETWORK")=="compose" else "127.0.0.1"
    conn=HTTPConnection(host,8000,timeout=3)
    try:
        headers={"Content-Type":"application/json"}
        if session_id:headers["X-Voice-Session"]=session_id
        conn.request("GET" if action=="events" else "POST",f"/api/voice/robot/{action}"+(f"?after={after}" if action=="events" else ""),headers=headers)
        response=conn.getresponse();body=json.loads(response.read(262144))
        if response.status!=200:raise DomainError(body.get("detail") or "음성 서비스를 확인하세요.",response.status)
        return body
    except (OSError,ValueError) as exc:raise DomainError("Mac 음성 서비스에 연결할 수 없습니다. YOLO_VOICE_ENABLED=1로 Mac 서버를 시작하고 한국어 모델을 확인하세요.",503) from exc
    finally:conn.close()


class PresetVoice:
    def __init__(self,engine):
        from .conversation import ConversationHistory
        self.history=ConversationHistory(engine.library.path.parent/'robot-voice-history.json')
        self.engine=engine;self.task=None;self.session=None;self.cursor=0;self.generation=0
        self.target="simulation";self.pending=None;self.message="음성 대기를 시작하세요.";self.transcript=""
        self.simulation=None;self.ui_seen=0;self.native_state="idle"
        self.stop_serial=0
        self.lifecycle_lock=asyncio.Lock()
        self.release_session=None
        self.selection=None;self.needs_preparation=None;self.class_request=None;self.catalog_checked=0

    @property
    def message(self):return self._message

    @message.setter
    def message(self,value):
        if value!=getattr(self,'_message',None) and (getattr(self,'session',None) or getattr(self,'transcript','')):
            self.history.append('assistant',value,context='robot',session_id=self.session,source='robot-guidance')
        self._message=value

    def invalidate(self,message="확인 대기를 취소했습니다.",*,keep_class=False):
        self.generation+=1
        if self.pending and self.pending.get("hardware_id"):
            self.engine.robot.picks.approvals.pop(self.pending["hardware_id"],None)
        if self.class_request:
            if self.class_request.get("choice"):self.class_request["choice"]["revoked"]=True
            if keep_class:
                self.class_request.update(generation=self.generation,choice=None)
            else:self.class_request=None
        self.pending=None;self.selection=None;self.needs_preparation=None;self.simulation=None;self.message=message

    def status(self,heartbeat=False):
        if heartbeat:self.ui_seen=time.monotonic()
        if self.pending and self.pending["deadline"]<=time.monotonic():self.invalidate("실행 확인이 만료되었습니다.")
        if self.pending:
            try:self.validate_pending()
            except DomainError as exc:self.invalidate(str(exc))
        if self.selection:
            try:self.validate_selection()
            except DomainError as exc:self.invalidate(str(exc))
        if self.class_request:
            try:self.validate_class()
            except DomainError as exc:self.invalidate(str(exc))
        private={"deadline","hardware_id","generation","confirm_after","versions","floor_revision","recipe","binding","session","preset"}
        public={k:v for k,v in self.pending.items() if k not in private} if self.pending else None
        if public:public['expires_in']=max(0,self.pending['deadline']-time.monotonic())
        selection={k:v for k,v in self.selection.items() if k not in private} if self.selection else None
        gate=None
        if self.class_request:
            c=self.class_request
            gate={k:c.get(k) for k in ("request_id","preset_id","revision","name","target","step_id","phase","model_version","model_name","classes","recognized")}
            gate["expires_in"]=max(0,c["deadline"]-time.monotonic())
        move=self.engine.robot.picks.moves.get(self.engine.robot.picks.active_id)
        return dict(listening=self.session is not None,can_stop=bool(self.session or self.release_session),state=self.native_state,target=self.target,message=self.message,transcript=self.transcript,
                    pending=public,selection=selection,class_request=gate,needs_preparation=self.needs_preparation,simulation=self.simulation,move=move,stop_serial=self.stop_serial,
                    busy=self.engine.robot.picks.busy or self.engine.robot.hand.busy or self.engine.robot.pose_tests.snapshot()["busy"])

    async def start(self,target):
        async with self.lifecycle_lock:
            if self.session:
                if target!=self.target:raise DomainError("음성 대기를 종료한 뒤 실행 대상을 변경하세요.")
                return self.status()
            await self.release_native()
            self.invalidate();generation=self.generation;native=await asyncio.to_thread(native_voice,"start")
            if generation!=self.generation:
                self.release_session=native["session_id"];await self.release_native()
                raise DomainError("음성 대기 시작이 취소되었습니다.")
            self.session=native["session_id"];self.cursor=native["cursor"];self.target=target;self.native_state=native["state"]
            self.message="등록한 명령을 말씀하세요."
            self.task=asyncio.create_task(self.poll())
            return self.status()

    def validate_class(self):
        c=self.class_request
        if not c or not self.session or c["session"]!=self.session or c["generation"]!=self.generation or c["deadline"]<=time.monotonic():
            raise DomainError("클래스 선택이 만료되었습니다. 실행 버튼을 눌러 클래스를 다시 선택하세요.")
        p=self.engine.library.get(c["preset_id"])
        if signature(p)!=c["signature"] or c["versions"]!=self.engine.legacy.versions() or c["floor_revision"]!=self.engine.robot.floor.value["revision"]:
            raise DomainError("설정 또는 중단 상태가 변경되었습니다. 클래스를 다시 선택하세요.",412)
        return c,p

    async def begin_class(self,p,step_id=None,sequence=0):
        self.engine.detections.criteria(p)
        if step_id and not any(s["id"]==step_id and s["kind"]!="checkpoint" for s in p["steps"]):raise DomainError("실행할 단계를 확인하세요.")
        self.invalidate("클래스 목록을 불러오고 있습니다.")
        self.transcript=""
        c=dict(request_id=uid(),preset_id=p["id"],revision=p["revision"],name=p["name"],target=self.target,step_id=step_id,
               phase="loading",session=self.session,generation=self.generation,signature=signature(p),versions=self.engine.legacy.versions(),
               floor_revision=self.engine.robot.floor.value["revision"],deadline=time.monotonic()+30,choice=None,recognized=None)
        self.class_request=c
        catalog=await self.engine.catalog()
        if self.class_request is not c:return
        self.validate_class()
        head=await asyncio.to_thread(native_voice,"events")
        if self.class_request is not c:return
        self.validate_class()
        if head.get("session_id")!=self.session or head.get("context","robot")!="robot":raise DomainError("음성 세션이 변경되었습니다.")
        c.update(catalog_signature=catalog_signature(catalog),model_version=catalog["model_version"],model_name=catalog["model_name"],
                 classes=copy.deepcopy(catalog["classes"]),after=max(sequence,self.cursor,head["cursor"]),phase="class")
        self.catalog_checked=time.monotonic();self.message="목록에 있는 클래스 이름 한 개를 말씀하세요. 이번 실행에만 사용합니다."

    async def request_class(self,identifier,revision,target,step_id=None):
        self.engine.legacy.require_idle()
        p=self.engine.library.get(identifier)
        if revision!=p["revision"]:raise DomainError("프리셋이 변경되었습니다. 최신 설정을 불러오세요.",412)
        self.engine.detections.criteria(p)
        await self.start(target)
        try:await self.begin_class(p,step_id)
        except DomainError as exc:self.invalidate(str(exc));raise
        return self.status()

    async def request_preset(self,identifier,revision,target):
        """Explicit selection can prepare a saved preset without adding an alias."""
        self.engine.legacy.require_idle();preset=self.engine.library.get(identifier)
        if revision!=preset['revision']:raise DomainError('프리셋이 변경되었습니다. 최신 경로를 불러오세요.',412)
        if preset['object_source']=='yolo':
            ids=[s['id'] for s in preset['steps']];start=ids.index(preset['range_start']) if preset['range_start'] else 0;end=ids.index(preset['range_end'])+1 if preset['range_end'] else len(ids)
            missing=[(s['name'] or s['kind'])+'의 목표 좌표를 입력하세요.' for s in preset['steps'][start:end]
                     if s['kind'] in {'movej','movel','movec'} and s['source']=='explicit' and s['target'] is None]
            if missing:raise DomainError(' '.join(missing))
            return await self.request_class(identifier,revision,target)
        recipe=self.engine.compile(preset,simulation=target=='simulation',defaults=target=='simulation',
                                  simulation_object=target=='simulation' and bool(preset['simulation_objects'][preset['region']]))
        if recipe['errors']:raise DomainError(' '.join(recipe['errors']))
        await self.start(target);self.invalidate('선택한 프리셋의 경로를 확인하고 있습니다.')
        await self.make_pending(preset,recipe,self.generation,self.session,self.engine.legacy.versions(),self.engine.robot.floor.value['revision'])
        return self.status()

    async def hear_class(self,event):
        c,p=self.validate_class()
        if c["phase"]=="loading" or event["sequence"]<=c["after"]:return
        catalog=await self.engine.catalog()
        if self.class_request is not c:return
        self.validate_class()
        if catalog_signature(catalog)!=c["catalog_signature"]:
            self.invalidate("YOLO 모델 또는 클래스 목록이 변경되었습니다. 실행 버튼으로 다시 시작하세요.");return
        try:entry=match_class(catalog,event["text"])
        except DomainError as exc:
            if c.get("choice"):
                self.invalidate(keep_class=True)
                c.update(phase="class",recognized=None,deadline=time.monotonic()+30,after=event["sequence"])
            self.message=str(exc);return
        self.invalidate(keep_class=True)
        c.update(phase="detecting",recognized=entry["name"],deadline=time.monotonic()+30,after=event["sequence"])
        choice=dict(class_id=entry["id"],class_label=entry["name"],model_version=catalog["model_version"],catalog_signature=c["catalog_signature"],
                    signature=c["signature"],versions=c["versions"],floor_revision=c["floor_revision"],session=self.session,generation=self.generation,
                    target=c["target"],step_id=c["step_id"],confirmation=p["confirmation"],deadline=c["deadline"],sequence=event["sequence"],revoked=False,consumed=False)
        c["choice"]=choice;self.message=entry["name"]+" · 최신 YOLO 대상을 확인하고 있습니다."
        try:capture=await self.engine.detections.capture(p,hardware=self.target=="hardware",choice=choice)
        except DomainError as exc:
            if self.class_request is not c:return
            if "인식 자세가 다릅니다" in str(exc):
                self.needs_preparation=dict(preset_id=p["id"],revision=p["revision"],name=p["name"]);c["phase"]="preparation";self.message=str(exc);return
            raise
        if self.class_request is not c:return
        self.validate_class()
        if capture["selected_id"] is None:
            self.message=capture["message"];c["phase"]="objects" if capture["state"]=="selection_required" else "no_match"
            if capture["state"]=="selection_required":
                self.selection=dict(request_id=uid(),preset_id=p["id"],revision=p["revision"],name=p["name"],target=self.target,
                                    detection=capture,generation=self.generation,session=self.session)
            return
        binding=self.engine.detections.bind(p,capture["snapshot_id"],capture["selected_id"])
        recipe=self.engine.compile(self.scoped(p),binding["resolved"],simulation=self.target=="simulation")
        await self.make_pending(p,recipe,self.generation,self.session,c["versions"],c["floor_revision"],binding)

    def scoped(self,p):
        step=self.class_request.get("step_id") if self.class_request else None
        return {**p,"range_start":step,"range_end":step} if step else p

    async def stop(self,notify_native=True):
        async with self.lifecycle_lock:
            self.release_session=self.session or self.release_session;self.session=None;self.invalidate("음성 대기를 종료했습니다. 실행 중인 작업은 별도 중단 버튼으로 제어하세요.")
            if self.task and self.task is not asyncio.current_task():
                self.task.cancel()
                with suppress(asyncio.CancelledError):await self.task
            self.task=None;self.native_state="idle"
            if notify_native:await self.release_native()
            else:self.release_session=None
            return self.status()

    async def release_native(self):
        if not self.release_session:return
        try:await asyncio.to_thread(native_voice,"stop",session_id=self.release_session)
        except DomainError as exc:
            if exc.status!=409:
                self.native_state="error";self.message="마이크 종료를 확인하지 못했습니다. 음성 대기 종료를 다시 누르세요. "+str(exc)
                raise
        self.release_session=None

    def match(self,text,*,simulation=None):
        word=normalized(text)
        matches=[p for p in self.engine.library.load()["presets"] if p["voice_enabled"] and word in {normalized(a) for a in p["aliases"]}]
        if len(matches)!=1:raise DomainError("미등록 또는 중복 명령입니다. 실행할 작업이 없습니다.")
        p=copy.deepcopy(matches[0]);virtual=self.target=='simulation' if simulation is None else simulation
        recipe=self.engine.compile(p,simulation=virtual,defaults=virtual,
                                  simulation_object=virtual and p['object_source']=='saved' and bool(p['simulation_objects'][p['region']]))
        if p["object_source"]=="yolo":self.engine.detections.criteria(p)
        elif recipe["errors"]:raise DomainError(" ".join(recipe["errors"]))
        return p,recipe

    async def test(self,text,snapshot_id=None,candidate_id=None,class_name=None):
        # Deliberately does not modify the real microphone confirmation state.
        if normalized(text) in {normalized(s) for s in ("로봇 실행","로봇 중단","중단","로봇 취소","음성 대기 종료")}:
            raise DomainError("공통 제어 명령은 문장 테스트로 실행하지 않습니다.")
        p,recipe=self.match(text,simulation=True)
        if p["object_source"]=="yolo":
            if snapshot_id is None:
                catalog=await self.engine.catalog()
                if not class_name:raise DomainError("문장 테스트에 사용할 클래스 이름도 입력하세요. 실제 마이크 선택과는 별개입니다.")
                entry=match_class(catalog,class_name)
                capture=await self.engine.detections.capture(p,criteria=dict(class_id=entry["id"],class_label=entry["name"],model_version=catalog["model_version"]))
                if capture["selected_id"] is None:
                    return dict(name=p["name"],revision=p["revision"],preset_id=p["id"],detection=capture,recipe=None,simulation_only=True)
                snapshot_id=capture["snapshot_id"];candidate_id=capture["selected_id"]
            binding=self.engine.detections.bind(p,snapshot_id,candidate_id)
            await self.engine.detections.revalidate(p,binding)
            recipe=self.engine.compile(p,binding["resolved"],simulation=True)
            if recipe["errors"]:raise DomainError(" ".join(recipe["errors"]))
        return dict(name=p["name"],revision=p["revision"],preset_id=p["id"],recipe=recipe,simulation_only=True)

    def validate_pending(self):
        p=self.pending
        if not p or p["deadline"]<=time.monotonic() or p["generation"]!=self.generation:raise DomainError("실행 확인이 만료되었습니다.")
        if self.engine.library.get(p["preset_id"])["revision"]!=p["revision"]:raise DomainError("프리셋이 변경되었습니다.")
        if p["versions"]!=self.engine.legacy.versions() or p["floor_revision"]!=self.engine.robot.floor.value["revision"]:raise DomainError("장비 또는 공통 설정이 변경되었습니다.")
        if p.get("binding"):
            self.engine.detections.check(self.engine.library.get(p["preset_id"]),p["binding"]["snapshot_id"])
        return p

    def validate_selection(self):
        selected=self.selection
        if not selected or selected["generation"]!=self.generation or selected["session"]!=self.session or not self.session:
            raise DomainError("음성 대상 선택이 취소되었습니다.")
        preset=self.engine.library.get(selected["preset_id"])
        self.engine.detections.check(preset,selected["detection"]["snapshot_id"])
        return selected

    async def select(self,request_id,candidate_id):
        selected=self.validate_selection()
        if selected["request_id"]!=request_id:raise DomainError("대상 선택 요청이 변경되었습니다.")
        self.selection=None
        preset=self.engine.library.get(selected["preset_id"])
        binding=self.engine.detections.bind(preset,selected["detection"]["snapshot_id"],candidate_id)
        recipe=self.engine.compile(self.scoped(preset),binding["resolved"],simulation=self.target=="simulation")
        await self.make_pending(preset,recipe,self.generation,self.session,self.engine.legacy.versions(),self.engine.robot.floor.value["revision"],binding)
        return self.status()

    async def hear(self,event):
        text=event["text"];word=normalized(text);self.transcript=text
        session_id=event.get('session_id',self.session)
        self.history.append('user',text,context='robot',session_id=session_id,turn=event.get('turn'),
                            key=f"{session_id}:{event['sequence']}:user",created_at=event.get('created_at'))
        if word in {normalized("로봇 중단"),normalized("중단")}:
            self.engine.robot.scenario.stop_all();self.message="로봇 작업 중단을 요청했습니다.";return
        if word==normalized("음성 대기 종료"):await self.stop();return
        if word==normalized("로봇 취소"):self.invalidate();return
        if word==normalized("로봇 실행"):
            p=self.validate_pending()
            if p["confirmation"]!="voice" or event["sequence"]<=p["confirm_after"]:raise DomainError("새 음성 재확인이 필요하거나 화면 승인이 필요한 작업입니다.")
            await self.confirm(p["approval_id"],from_voice=True);return
        if self.class_request:
            # Another registered preset cancels this selection; other words are class attempts.
            if word in {normalized(c["name"]) for c in self.class_request.get("classes",[])}:
                await self.hear_class(event);return
            try:self.match(text)
            except DomainError:
                await self.hear_class(event);return
        self.invalidate()
        self.engine.legacy.require_idle()
        preset,recipe=self.match(text);generation=self.generation;session=self.session
        versions=self.engine.legacy.versions();floor=self.engine.robot.floor.value["revision"]
        binding=None
        if preset["object_source"]=="yolo":
            await self.begin_class(preset,sequence=event["sequence"]);return
        await self.make_pending(preset,recipe,generation,session,versions,floor,binding)

    async def make_pending(self,preset,recipe,generation,session,versions,floor,binding=None):
        if recipe["errors"]:raise DomainError(" ".join(recipe["errors"]))
        hardware=None;published=False
        def cancelled():return generation!=self.generation or not session or session!=self.session
        try:
            if binding:
                await self.engine.detections.revalidate(preset,binding)
                if cancelled():return
            kwargs=dict(snapshot_id=binding["snapshot_id"],candidate_id=binding["candidate_id"]) if binding else {}
            step_id=self.class_request.get("step_id") if self.class_request else None
            hardware=await self.engine.preview(preset["id"],preset["revision"],step_id=step_id,**kwargs) if self.target=="hardware" else None
            if cancelled():return
            head=await asyncio.to_thread(native_voice,"events")
            # Every await may overlap stop, save, or a replacement microphone session.
            if cancelled():return
            if head.get("session_id")!=session or head.get("context","robot")!="robot":raise DomainError("음성 세션이 변경되었습니다.")
            if versions!=self.engine.legacy.versions() or floor!=self.engine.robot.floor.value["revision"] or self.engine.library.get(preset["id"])["revision"]!=preset["revision"]:
                raise DomainError("설정이 변경되었습니다. 명령을 다시 말씀하세요.")
            self.engine.legacy.require_idle()
            approval=self.engine.robot.picks.approvals.get(hardware["approval_id"]) if hardware else None
            if hardware and (not approval or approval["deadline"]<=time.monotonic()):raise DomainError("실행 확인이 만료되었습니다.")
            deadline=approval["deadline"] if approval else time.monotonic()+30
            if binding:
                self.engine.detections.check(preset,binding["snapshot_id"])
                deadline=min(deadline,binding["deadline"])
            ids=[s["id"] for s in preset["steps"]]
            range_label=f'{ids.index(step_id)+1}번 동작' if step_id else "전체 경로" if not preset["range_start"] else " → ".join(f'{ids.index(preset[key])+1} · {preset["steps"][ids.index(preset[key])]["name"] or "동작"}' for key in ("range_start","range_end"))
            self.pending=dict(approval_id=uid(),hardware_id=hardware["approval_id"] if hardware else None,preset_id=preset["id"],name=preset["name"],revision=preset["revision"],
                confirmation=preset["confirmation"],total_steps=len(recipe["steps"]),range_label=range_label,target=self.target,deadline=deadline,generation=generation,
                confirm_after=max(head["cursor"],binding["voice_choice"]["sequence"] if binding and binding.get("voice_choice") else 0),
                versions=versions,floor_revision=floor,recipe=copy.deepcopy(recipe),binding=binding,
                detected=copy.deepcopy(binding["resolved"]) if binding else None)
            published=True
            if self.class_request:self.class_request["phase"]="approval"
            self.message=preset["name"]+" · "+("‘로봇 실행’을 말씀하세요." if preset["confirmation"]=="voice" else "화면에서 승인하세요.")
        finally:
            if hardware and not published:self.engine.robot.picks.approvals.pop(hardware["approval_id"],None)

    async def confirm(self,identifier,from_voice=False):
        p=self.validate_pending()
        self.engine.legacy.require_idle()
        if identifier!=p["approval_id"]:raise DomainError("실행 확인 ID가 다릅니다.")
        if p["confirmation"]=="voice" and not from_voice:raise DomainError("마이크의 ‘로봇 실행’ 재확인이 필요합니다.")
        if p.get("binding"):
            preset=self.engine.library.get(p["preset_id"])
            await self.engine.detections.current_choice(preset,p["binding"].get("voice_choice"))
            if self.validate_pending() is not p:raise DomainError("실행 확인이 변경되었습니다.")
        if p["target"]=="simulation" and time.monotonic()-self.ui_seen>5:raise DomainError("시뮬레이션 화면을 열어주세요.")
        if p["target"]=="hardware":
            try:result=await self.engine.approve(p["hardware_id"],from_voice=from_voice)
            except Exception as exc:
                self.invalidate(str(exc));raise
        else:
            result=dict(id=uid(),recipe=copy.deepcopy(p["recipe"]))
            self.simulation=result
            if p.get("binding"):p["binding"]["voice_choice"]["consumed"]=True
        self.pending=None;self.selection=None;self.class_request=None;self.message=p["name"]+" 실행을 요청했습니다. "+("새 실행에는 클래스를 다시 선택하세요." if p.get('binding') else "새 실행에는 명령을 다시 입력하고 확인하세요.")
        return result

    async def poll(self):
        session=self.session;consumer=asyncio.current_task()
        def owns_session():return self.session==session and self.task is consumer
        try:
            while session and owns_session():
                data=await asyncio.to_thread(native_voice,"events",self.cursor)
                if not owns_session():return
                if data.get("context")!="robot" or data.get("session_id")!=session:
                    raise DomainError(data.get("error") or "마이크 세션이 종료되었습니다.")
                self.native_state=data["state"]
                events=[e for e in data["events"] if e["session_id"]==self.session and e["sequence"]>self.cursor]
                self.cursor=data["cursor"]
                stops=[e for e in events if normalized(e["text"]) in {normalized("로봇 중단"),normalized("중단"),normalized("음성 대기 종료")}]
                for event in sorted(stops,key=lambda e:normalized(e["text"])==normalized("음성 대기 종료")) or events:
                    if not owns_session():return
                    try:await self.hear(event)
                    except DomainError as exc:
                        if self.class_request and not self.pending and normalized(event["text"])==normalized("로봇 실행"):
                            self.message="클래스와 탐지 객체를 먼저 선택하세요."
                        else:self.invalidate(str(exc))
                if self.class_request and time.monotonic()-self.catalog_checked>1:
                    c=self.class_request;self.catalog_checked=time.monotonic();catalog=await self.engine.catalog()
                    if self.class_request is c and c.get("catalog_signature") and catalog_signature(catalog)!=c["catalog_signature"]:
                        self.invalidate("YOLO 모델 또는 클래스 목록이 변경되었습니다. 실행 버튼으로 다시 시작하세요.")
                self.status()
                await asyncio.sleep(.25)
        except asyncio.CancelledError:raise
        except Exception as exc:
            async with self.lifecycle_lock:
                if not owns_session():return
                self.session=None;self.task=None;self.native_state="error";self.invalidate(str(exc))
                # Release only this owner, even if the native service has already replaced it.
                self.release_session=session
                with suppress(DomainError):await self.release_native()


class Listening(Input):
    target: Literal["simulation","hardware"] = "simulation"


class TextTest(Input):
    text: str = Field(min_length=1,max_length=300)
    snapshot_id: str | None = Field(default=None,pattern=r"^[a-f0-9]{32}$")
    candidate_id: str | None = Field(default=None,pattern=r"^[a-f0-9]{32}$")
    class_name: str | None = Field(default=None,min_length=1,max_length=256)


class ClassRequest(Listening):
    preset_id: str
    revision: str
    step_id: str | None = Field(default=None,min_length=1,max_length=64,pattern=r"^[a-zA-Z0-9_-]+$")


class VoiceSelection(Input):
    request_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    candidate_id: str = Field(pattern=r"^[a-f0-9]{32}$")


class VoiceApproval(Input):
    approval_id:str


router=APIRouter(prefix="/preset-voice")

def voice(request):
    e=request.app.state.robot.presets;e.modules.load();return e.voice

@router.get("/status")
async def status(request:Request,heartbeat:bool=False):return voice(request).status(heartbeat=heartbeat)

@router.get('/history')
async def history(request:Request,after:int=Query(default=0,ge=0)):
    return voice(request).history.snapshot(after)

@router.post("/start",dependencies=[Depends(local_json)])
async def start(body:Listening,request:Request):return await voice(request).start(body.target)

@router.post("/stop",dependencies=[Depends(local_json)])
async def stop(request:Request):return await voice(request).stop()

@router.post("/test",dependencies=[Depends(local_json)])
async def text_test(body:TextTest,request:Request):return await voice(request).test(body.text,body.snapshot_id,body.candidate_id,body.class_name)

@router.post("/class-request",dependencies=[Depends(local_json)])
async def class_request(body:ClassRequest,request:Request):return await voice(request).request_class(body.preset_id,body.revision,body.target,body.step_id)

@router.post('/preset-request',dependencies=[Depends(local_json)])
async def preset_request(body:ClassRequest,request:Request):
    if body.step_id is not None:raise DomainError('대시보드에서는 저장된 실행 범위 전체를 준비하세요.',422)
    return await voice(request).request_preset(body.preset_id,body.revision,body.target)

@router.post("/select",dependencies=[Depends(local_json)])
async def select(body:VoiceSelection,request:Request):return await voice(request).select(body.request_id,body.candidate_id)

@router.post("/approve",dependencies=[Depends(local_json)])
async def approve(body:VoiceApproval,request:Request):return await voice(request).confirm(body.approval_id)

@router.post("/cancel",dependencies=[Depends(local_json)])
async def cancel(request:Request):
    v=voice(request);v.invalidate();return v.status()
