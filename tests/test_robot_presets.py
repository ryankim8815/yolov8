"""Saved paths, SDK sequencing, and voice authorization; all devices are synthetic."""
import asyncio
import copy
import time
from pathlib import Path

import pytest

from tests.test_robot_scenario import scenario, wait_state
from app.robot_preset_config import MotionPreset, compile_preset, child_id
from app.store import DomainError


BASE='/api/robot/presets'


def library(client):return client.get(BASE).json()['presets']


def create(client,steps,**kwargs):
    result=client.post(BASE,json=dict(name='테스트 경로',steps=steps,**kwargs))
    assert result.status_code==201,result.text
    return result.json()


def ready(client,p):
    result=client.post(f'{BASE}/{p["id"]}/execution-preview',json={'revision':p['revision']})
    assert result.status_code==200,result.text
    return result.json()


def test_migration_backup_and_independent_snapshot(scenario):
    client,calls,*_=scenario;robot=client.app.state.robot
    original=robot.scenario.config.path.read_bytes();points=copy.deepcopy(robot.work_points.points)
    p=library(client)[0]
    assert p['name']=='기존 이동 경로' and not p['voice_enabled'] and p['aliases']==[]
    assert p['box_pose']==points['box']['pose']
    compiled=client.post(f'{BASE}/{p["id"]}/preview',json={}).json()
    assert not compiled['errors'] and len(compiled['steps'])==17
    assert [s['kind'] for s in compiled['steps'][:7]]==['joint','gripper','joint','gripper','line','gripper','line']
    assert compiled['steps'][2]['target']==compiled['steps'][6]['target']
    assert compiled['steps'][8]['target']==[0,0,60,0,120,0]
    assert robot.scenario.config.path.read_bytes()==original and robot.work_points.points==points
    backups=list(robot.scenario.config.path.parent.glob('backups/preset-migration-*/pick-scenario.json'))
    assert len(backups)==1 and backups[0].read_bytes()==original
    assert library(client)[0]==p and len(list(robot.scenario.config.path.parent.glob('backups/*')))==1
    assert not calls


def test_crud_voice_collision_versions_and_limits(scenario):
    client,*_=scenario
    p=create(client,[dict(kind='wait',seconds=.1)],voice_enabled=True,aliases=['로봇 A 박스'])
    duplicate=client.post(BASE,json=dict(name='다른 경로',steps=[dict(kind='wait')],aliases=['로봇a박스']))
    assert duplicate.status_code==409
    assert client.post(BASE,json=dict(aliases=['로봇 중단'])).status_code==422
    assert client.post(BASE,json=dict(steps=[dict(kind='wait',seconds=.09)])).status_code==422
    assert client.post(BASE,json=dict(steps=[dict(kind='wait')]*101)).status_code==422
    assert client.post(BASE,json=dict(steps=[dict(id='same',kind='wait')]*2)).status_code==422
    assert client.post(BASE,json=dict(steps=[dict(id='group',kind='grasp'),dict(id=child_id('group',0),kind='wait')])).status_code==422
    c=client.post(f'{BASE}/{p["id"]}/copy',json={'revision':p['revision']}).json()
    assert c['id']!=p['id'] and not c['voice_enabled'] and not c['aliases']
    p['name']='수정';saved=client.put(f'{BASE}/{p["id"]}',json=p)
    assert saved.status_code==200 and saved.json()['revision']!=p['revision']
    assert client.put(f'{BASE}/{p["id"]}',json=p).status_code==412


def test_group_lock_ranges_and_stable_references(scenario):
    client,*_=scenario;p=library(client)[0]
    grasp=next(s for s in p['steps'] if s['kind']=='grasp')
    grasp['children'][0]['target']=[100,100,100,0,0,0]
    result=client.post(f'{BASE}/{p["id"]}/preview',json={'preset':p}).json()
    assert result['steps'][2]['target']!=[100,100,100,0,0,0]
    bad=copy.deepcopy(p);next(s for s in bad['steps'] if s['kind']=='grasp')['children'].reverse()
    assert client.put(f'{BASE}/{p["id"]}',json=bad).status_code==422
    bad={**p,'range_start':grasp['children'][1]['id'],'range_end':grasp['id']}
    assert client.put(f'{BASE}/{p["id"]}',json=bad).status_code==422
    p['range_start']=p['range_end']=grasp['id']
    result=client.post(f'{BASE}/{p["id"]}/preview',json={'preset':p}).json()
    assert len(result['steps'])==5 and [s['number'] for s in result['steps']]==[1,2,3,4,5]
    bad=copy.deepcopy(p);bad['steps']=[s for s in bad['steps'] if s['source']!='waypoint1']
    assert client.put(f'{BASE}/{p["id"]}',json=bad).status_code==422


def test_variable_sequence_and_one_shot_approval(scenario):
    client,calls,*_=scenario
    p=create(client,[dict(kind='movej',target=[10,0,90,0,90,0],percent=30),dict(kind='gripper',opening_mm=50,percent=40),dict(kind='wait',seconds=.1)])
    ticket=ready(client,p)
    assert len(ticket['steps'])==3 and not calls
    assert client.post(BASE+'/executions/approve',json={'approval_id':ticket['approval_id']}).status_code==202
    assert client.post(BASE+'/executions/approve',json={'approval_id':ticket['approval_id']}).status_code==409
    assert wait_state(client,ticket['approval_id'],{'completed','failed','unknown'})['state']=='completed'
    assert [c.kind for c in calls]==['joint','gripper']
    assert calls[0].speed==3 and calls[1].speed==4
    assert client.get('/api/robot/pick/moves/'+ticket['approval_id']).json()['total_steps']==3


def test_wait_stop_and_stale_approval(scenario):
    client,calls,*_=scenario;p=create(client,[dict(kind='wait',seconds=2)])
    ticket=ready(client,p)
    assert client.post('/api/robot/stop',json={}).status_code==200
    assert client.post(BASE+'/executions/approve',json={'approval_id':ticket['approval_id']}).status_code==409
    ticket=ready(client,p)
    client.post(BASE+'/executions/approve',json={'approval_id':ticket['approval_id']})
    assert client.put(f'{BASE}/{p["id"]}',json=p).status_code==409
    client.post('/api/robot/stop',json={})
    assert wait_state(client,ticket['approval_id'],{'cancelled','failed','unknown'})['state']=='cancelled'
    assert not calls


def test_migrated_full_route_executes_all_saved_operations(scenario):
    client,calls,*_=scenario;p=library(client)[0];ticket=ready(client,p)
    result=client.post(BASE+'/executions/approve',json={'approval_id':ticket['approval_id']});assert result.status_code==202,result.text
    move=wait_state(client,ticket['approval_id'],{'completed','failed','unknown'})
    assert move['state']=='completed',move
    assert len(calls)==17 and sum(c.kind=='gripper' for c in calls)==5


def test_voice_tests_cannot_approve_and_native_event_confirmation(scenario,monkeypatch):
    client,calls,*_=scenario
    p=create(client,[dict(kind='wait',seconds=.1)],voice_enabled=True,aliases=['로봇 대기'],confirmation='voice')
    v=client.app.state.robot.presets.voice
    monkeypatch.setattr('app.robot_preset_voice.native_voice',lambda *a,**kw:dict(session_id='asr',cursor=1,context='robot',events=[],state='listening'))
    result=client.post('/api/robot/preset-voice/test',json={'text':'로봇 대기'}).json()
    assert result['simulation_only'] and not v.pending and not calls
    assert client.post('/api/robot/preset-voice/test',json={'text':'로봇 실행'}).status_code==409
    async def test():
        v.session='asr';v.ui_seen=time.monotonic()
        await v.hear(dict(text='로봇 대기',sequence=1))
        identifier=v.pending['approval_id']
        with pytest.raises(DomainError):v.confirm(identifier)
        with pytest.raises(DomainError):await v.hear(dict(text='로봇 실행',sequence=1))
        await v.hear(dict(text='로봇 실행',sequence=2))
        assert v.simulation and not v.pending
        assert not calls
        v.session=None
    client.portal.call(test)


def test_voice_screen_hardware_approval_and_stop_priority(scenario,monkeypatch):
    client,calls,*_=scenario
    p=create(client,[dict(kind='movej',target=[0,0,90,0,90,0])],voice_enabled=True,aliases=['로봇 제자리'])
    v=client.app.state.robot.presets.voice
    monkeypatch.setattr('app.robot_preset_voice.native_voice',lambda *a,**kw:dict(session_id='asr',cursor=1))
    async def test():
        v.session='asr';v.target='hardware'
        await v.hear(dict(text='로봇 제자리',sequence=1))
        assert not calls
        identifier=v.pending['approval_id']
        with pytest.raises(DomainError):await v.hear(dict(text='로봇 실행',sequence=2))
        await v.hear(dict(text='로봇 중단',sequence=3))
        assert v.pending is None
        with pytest.raises(DomainError):v.confirm(identifier)
        await v.hear(dict(text='로봇 제자리',sequence=4))
        move=v.confirm(v.pending['approval_id'])
        v.session=None
        return move
    move=client.portal.call(test)
    assert wait_state(client,move['approval_id'],{'completed','failed','unknown'})['state']=='completed'
    assert len(calls)==1


def test_continuous_native_voice_is_domain_isolated():
    from app.voice import Voice
    class Stream:
        def write(self,data):pass
        async def drain(self):pass
    class Process:stdin=Stream()
    async def run():
        v=Voice(None,True);v.session='native';v.context='robot';v.process=Process();v.state='listening';v.turn=1
        event=dict(event='final',session='native',turn=1,text='로봇 이동')
        await v.event(event)
        assert v.robot_sequence==1 and v.turn==2 and v.state=='preparing'
        await v.event(event);assert v.robot_sequence==1
        v.state='listening';await v.event(dict(event='timeout',session='native',turn=2))
        assert v.session=='native' and v.turn==3
        with pytest.raises(DomainError):await v.wake()
    asyncio.run(run())


def test_migration_preserves_manual_drop_and_separate_preparation_speeds(scenario):
    client,*_=scenario
    cfg=client.get('/api/robot/pick-scenario').json()
    cfg['stages']['1'].update(motion='movel',profile='medium',override=dict(speed=3,acceleration=3))
    cfg['stages']['10']['target_joints']=[10,0,70,0,110,0]
    assert client.put('/api/robot/pick-scenario',json=cfg).status_code==200
    p=library(client)[0];recipe=client.post(f'{BASE}/{p["id"]}/preview',json={}).json()
    assert not recipe['errors']
    assert recipe['steps'][0]['kind']=='line' and recipe['steps'][0]['speed']['speed']==3
    assert recipe['steps'][1]['speed']['speed']==5
    assert recipe['steps'][9]['target']==[10,0,70,0,110,0]
    assert recipe['steps'][8]['j1_only'] and recipe['steps'][14]['j1_only']


def test_controller_session_loss_never_dispatches(scenario):
    client,calls,_,status,*_=scenario
    p=create(client,[dict(kind='movej',target=[0,0,90,0,90,0])]);ticket=ready(client,p)
    status['session_id']='another-session'
    client.post(BASE+'/executions/approve',json={'approval_id':ticket['approval_id']})
    assert wait_state(client,ticket['approval_id'],{'failed','unknown'})['state']=='failed'
    assert not calls


def test_floor_change_during_preview_invalidates_ticket(scenario,monkeypatch):
    client,calls,*_=scenario;engine=client.app.state.robot.presets
    p=create(client,[dict(kind='movej',target=[0,0,90,0,90,0])]);original=engine.legacy.inspect;count=0
    async def change(*args,**kwargs):
        nonlocal count
        result=await original(*args,**kwargs);count+=1
        if count==2:engine.robot.floor.value['revision']='changed'
        return result
    monkeypatch.setattr(engine.legacy,'inspect',change)
    assert client.post(f'{BASE}/{p["id"]}/execution-preview',json={'revision':p['revision']}).status_code==412
    assert not calls


def test_audio_poll_prioritizes_stop_over_queued_run_and_deduplicates(scenario,monkeypatch):
    client,calls,*_=scenario
    create(client,[dict(kind='wait',seconds=.1)],voice_enabled=True,aliases=['로봇 작업'],confirmation='voice')
    v=client.app.state.robot.presets.voice
    events=[dict(session_id='asr',sequence=i+1,text=text) for i,text in enumerate(['로봇 작업','로봇 실행','로봇 중단'])]
    monkeypatch.setattr('app.robot_preset_voice.native_voice',lambda *a,**kw:dict(session_id='asr',context='robot',cursor=3,events=events,state='listening'))
    async def run():
        v.session='asr';v.target='hardware';v.task=asyncio.create_task(v.poll())
        await asyncio.sleep(.35)
        assert v.cursor==3 and not v.pending and not calls
        generation=v.generation
        await asyncio.sleep(.3)
        assert v.generation==generation
        await v.stop(notify_native=False)
    client.portal.call(run)
