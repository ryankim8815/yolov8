"""Adversarial timing and migration checks for preset editing and voice execution."""
import asyncio
import threading

import pytest

from tests.test_robot_scenario import scenario
from tests.test_robot_presets import create, library, BASE
from app.robot_preset_config import PresetStep, physical_speed
from app.robot_scenario import compile_steps, approach_pose
from app.store import DomainError


@pytest.mark.parametrize('overrides', [{8:[10,0,70,0,110,0]}, {9:[10,0,70,0,110,0]}, {8:[10,0,70,0,110,0],14:[20,0,80,0,100,0]}])
def test_migration_never_retargets_manually_overridden_waypoints(scenario,overrides):
    client,*_=scenario;robot=client.app.state.robot
    cfg=client.get('/api/robot/pick-scenario').json()
    for n,q in overrides.items():cfg['stages'][str(n)]['target_joints']=q
    assert client.put('/api/robot/pick-scenario',json=cfg).status_code==200
    p=library(client)[0];recipe=robot.presets.compile(p)
    pose=[*cfg['virtual']['floor']['center_base_mm'],0,180,0]
    old=compile_steps(cfg,pose,approach_pose(cfg,'floor',pose),p['box_pose'],50,80)
    # The expanded preparation replaces the no-motion object-selection row; 3..17 retain indices.
    for number in (8,9,14,15,16):
        assert recipe['steps'][number-1]['target']==old[number-1]['target']


def test_explicit_gripper_acceleration_survives_speed_change():
    step=PresetStep(kind='gripper',acceleration=5,percent=30)
    assert physical_speed(step,True)==dict(speed=3,acceleration=5)
    assert physical_speed(PresetStep(kind='gripper'),True)['acceleration']==3000


def test_empty_or_unknown_execution_selection_is_rejected(scenario):
    client,calls,*_=scenario;p=library(client)[0]
    for identifier,code in [('',422),('missing',404)]:
        response=client.post(f'{BASE}/{p["id"]}/execution-preview',json={'revision':p['revision'],'step_id':identifier})
        assert response.status_code==code,response.text
    checkpoint=next(s for s in p['steps'] if s['kind']=='checkpoint')
    p.update(range_start=checkpoint['id'],range_end=checkpoint['id'])
    assert client.put(f'{BASE}/{p["id"]}',json=p).status_code==422
    assert not calls


@pytest.mark.parametrize('target', ['simulation','hardware'])
def test_stop_during_voice_head_read_cannot_recreate_pending(scenario,monkeypatch,target):
    client,calls,*_=scenario
    create(client,[dict(kind='wait',seconds=.1)],voice_enabled=True,aliases=['로봇 작업'])
    v=client.app.state.robot.presets.voice
    entered=threading.Event();release=threading.Event()
    def native(*args,**kwargs):
        entered.set();assert release.wait(3)
        return dict(session_id='asr',context='robot',cursor=1,state='listening',events=[])
    monkeypatch.setattr('app.robot_preset_voice.native_voice',native)
    async def run():
        v.session='asr';v.target=target
        request=asyncio.create_task(v.hear(dict(text='로봇 작업',sequence=1)))
        try:
            assert await asyncio.to_thread(entered.wait,2)
            v.engine.robot.scenario.stop_all()
        finally:release.set()
        await request
        assert v.pending is None
        assert not v.engine.robot.picks.approvals
        v.session=None
    client.portal.call(run);assert not calls


def test_concurrent_listen_starts_have_one_owner(scenario,monkeypatch):
    client,*_=scenario;v=client.app.state.robot.presets.voice
    entered=threading.Event();release=threading.Event();starts=[]
    def native(action,*args,**kwargs):
        if action=='start':starts.append(action);entered.set();assert release.wait(3)
        return dict(session_id='asr',context='robot',cursor=0,state='listening',events=[])
    monkeypatch.setattr('app.robot_preset_voice.native_voice',native)
    async def run():
        tasks=[]
        try:
            tasks.append(asyncio.create_task(v.start('simulation')))
            assert await asyncio.to_thread(entered.wait,2)
            tasks.append(asyncio.create_task(v.start('simulation')))
            await asyncio.sleep(.03);release.set();await asyncio.gather(*tasks)
            assert len(starts)==1
        finally:
            release.set();await v.stop(notify_native=False)
            # Clean up even a buggy duplicate consumer so the regression fails without leaking tasks.
            for task in asyncio.all_tasks():
                if task is not asyncio.current_task() and task.get_coro().__qualname__.endswith('PresetVoice.poll'):
                    task.cancel()
    client.portal.call(run)


def test_stop_waits_for_inflight_microphone_start(scenario,monkeypatch):
    client,*_=scenario;v=client.app.state.robot.presets.voice
    entered=threading.Event();release=threading.Event();stops=[]
    def native(action,*args,**kwargs):
        if action=='start':entered.set();assert release.wait(3)
        if action=='stop':stops.append(action)
        return dict(session_id='asr',context='robot',cursor=0,state='listening',events=[])
    monkeypatch.setattr('app.robot_preset_voice.native_voice',native)
    async def run():
        starting=asyncio.create_task(v.start('simulation'))
        assert await asyncio.to_thread(entered.wait,2)
        stopping=asyncio.create_task(v.stop())
        await asyncio.sleep(.03);release.set();await asyncio.gather(starting,stopping)
        try:assert v.session is None and len(stops)==1
        finally:await v.stop(notify_native=False)
    client.portal.call(run)


def test_stale_native_stop_cannot_close_replacement_session():
    from app.voice import Voice
    async def run():
        v=Voice(None,True);v.session='new';v.context='robot'
        with pytest.raises(DomainError):await v.stop(session_only=True,expected_session='old')
        assert v.session=='new'
    asyncio.run(run())


def test_migrated_manual_drop_keeps_dynamic_object_and_idle_openings(scenario):
    client,*_=scenario
    cfg=client.get('/api/robot/pick-scenario').json()
    cfg['stages']['10']['target_joints']=[10,0,70,0,110,0]
    assert client.put('/api/robot/pick-scenario',json=cfg).status_code==200
    p=library(client)[0]
    p['context']['virtual']['floor']['size_mm'][0]=60
    p['context']['standby_opening_mm']=75
    from tests.test_module_library import modules,update
    module=modules(client)[0];module['settings']['opening_mm']=75;update(client,module)
    recipe=client.post(f'{BASE}/{p["id"]}/preview',json={'preset':p}).json()
    assert recipe['steps'][11]['opening_mm']==70
    assert recipe['steps'][16]['opening_mm']==75


def test_microphone_release_failure_remains_retryable(scenario,monkeypatch):
    client,*_=scenario;v=client.app.state.robot.presets.voice;stops=[]
    def native(action,*args,**kwargs):
        stops.append(kwargs['session_id'])
        if len(stops)==1:raise DomainError('disconnected',503)
        return {}
    monkeypatch.setattr('app.robot_preset_voice.native_voice',native)
    async def run():
        v.session='owned'
        with pytest.raises(DomainError):await v.stop()
        assert not v.session and v.status()['can_stop']
        await v.stop()
        assert not v.status()['can_stop'] and stops==['owned','owned']
    client.portal.call(run)


def test_consumer_disconnect_releases_only_its_microphone(scenario,monkeypatch):
    client,*_=scenario;v=client.app.state.robot.presets.voice;stops=[]
    def native(action,*args,**kwargs):
        if action=='events':raise DomainError('connection lost',503)
        stops.append(kwargs['session_id']);return {}
    monkeypatch.setattr('app.robot_preset_voice.native_voice',native)
    async def run():
        v.session='old';v.task=asyncio.create_task(v.poll())
        await v.task
        assert not v.session and v.pending is None and stops==['old']
    client.portal.call(run)


def test_stop_precedes_listen_end_in_same_native_event_batch(scenario,monkeypatch):
    client,*_=scenario;v=client.app.state.robot.presets.voice;robot=client.app.state.robot
    def native(action,*args,**kwargs):
        return dict(session_id='asr',context='robot',cursor=2,state='listening',events=[
            dict(session_id='asr',sequence=1,text='음성 대기 종료'),dict(session_id='asr',sequence=2,text='로봇 중단')])
    monkeypatch.setattr('app.robot_preset_voice.native_voice',native)
    async def run():
        old=robot.scenario.stop_generation
        v.session='asr';v.task=asyncio.create_task(v.poll());await v.task
        assert not v.session and robot.scenario.stop_generation==old+1
    client.portal.call(run)


def test_voice_confirmation_identifies_saved_execution_range(scenario,monkeypatch):
    client,calls,*_=scenario
    p=create(client,[dict(id=name,kind='wait',name=name,seconds=.1) for name in ('A','B','C')],aliases=['로봇 범위'],voice_enabled=True)
    p.update(range_start='B',range_end='B')
    assert client.put(f'{BASE}/{p["id"]}',json=p).status_code==200
    v=client.app.state.robot.presets.voice
    monkeypatch.setattr('app.robot_preset_voice.native_voice',lambda *a,**kw:dict(session_id='asr',cursor=1,context='robot'))
    async def run():
        v.session='asr'
        await v.hear(dict(text='로봇 범위',sequence=1))
        assert v.pending['total_steps']==1 and v.pending['range_label']=='2 · B → 2 · B'
        v.invalidate();v.session=None
    client.portal.call(run);assert not calls
