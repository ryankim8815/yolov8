"""Runtime class gates use final fake ASR events, a model catalog and fake SDK only."""
import asyncio
import copy
import threading
import time

import pytest

from app.store import DomainError
from app.robot_preset_class import match_class
from tests.test_robot_scenario import scenario
from tests.test_robot_presets import BASE
from tests.test_preset_yolo import yolo,enable_voice,capture


@pytest.fixture
def voice_class(scenario,monkeypatch):
    client,calls,frame,*_=scenario
    catalog=dict(model_version='v1',model_name='테스트 모델',classes=[dict(id=0,name='상품'),dict(id=1,name='스팸')])
    monkeypatch.setattr('app.robot_presets.read_yolo_catalog',lambda:copy.deepcopy(catalog))
    events=[]
    def native(action,after=0,**kw):
        return dict(session_id='asr',context='robot',cursor=max((e['sequence'] for e in events),default=0),state='listening',events=[e for e in events if e['sequence']>after])
    monkeypatch.setattr('app.robot_preset_voice.native_voice',native)
    p=enable_voice(client,yolo(client));v=client.app.state.robot.presets.voice
    v.session='asr';v.ui_seen=time.monotonic()
    def hear(text,sequence):return client.portal.call(v.hear,dict(text=text,sequence=sequence,session_id='asr'))
    yield client,calls,frame,catalog,p,v,hear,events
    client.portal.call(v.stop,False)


def test_preset_command_prompts_for_one_active_class_before_detection(voice_class):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    hear('로봇 탐지 포장',1)
    status=v.status();gate=status['class_request']
    assert gate['phase']=='class' and gate['classes']==catalog['classes']
    assert status['pending'] is None and status['selection'] is None
    assert not v.engine.detections.snapshots and not calls
    assert 'choice' not in gate and 'signature' not in gate


@pytest.mark.parametrize('utterance',['스펨','상품 스팸','상품 또는 스팸','스팸 주세요','알 수 없음'])
def test_unregistered_or_multiple_class_utterances_keep_listening_without_execution(voice_class,utterance):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    hear('로봇 탐지 포장',1);identifier=v.class_request['request_id']
    hear(utterance,2)
    assert v.class_request['request_id']==identifier and v.class_request['phase']=='class'
    assert v.pending is None and v.selection is None and not calls
    assert '한 개만' in v.message
    with pytest.raises(DomainError):hear('로봇 실행',3)


def test_current_class_selection_is_dynamic_and_never_saved_to_preset(voice_class):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    frame['objects'][0].update(class_id=1,label='스팸')
    hear('로봇 탐지 포장',1);hear('스 팸.',2)
    assert v.pending['detected']['class_id']==1 and v.pending['detected']['label']=='스팸'
    assert v.class_request['recognized']=='스팸' and v.pending['target']=='simulation'
    assert client.get(f'{BASE}/{p["id"]}').json()==p
    client.portal.call(v.confirm,v.pending['approval_id'])
    assert v.simulation['recipe']['detected']['label']=='스팸' and v.class_request is None
    hear('로봇 탐지 포장',3)
    assert v.class_request['recognized'] is None and v.pending is None and not calls


def test_invalid_utterance_after_valid_choice_cancels_old_approval(voice_class):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    hear('로봇 탐지 포장',1);hear('상품',2)
    identifier=v.pending['approval_id'];hear('상품 스팸',3)
    assert v.pending is None and v.class_request['phase']=='class'
    assert v.class_request['recognized'] is None
    with pytest.raises(DomainError):client.portal.call(v.confirm,identifier)
    assert not calls


def test_valid_class_without_objects_does_not_fall_back_to_saved_class(voice_class):
    *_,v,hear,events=voice_class
    hear('로봇 탐지 포장',1);hear('스팸',2)
    assert v.class_request['phase']=='no_match' and v.pending is None
    assert '대상이 없습니다' in v.message


def test_yolo_preset_does_not_require_a_persisted_model_or_class(voice_class):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    p['yolo'].update(class_id=None,class_label='',model_version=None)
    p=client.put(f'{BASE}/{p["id"]}',json=p).json()
    hear('로봇 탐지 포장',1);hear('상품',2)
    assert v.pending and v.pending['detected']['class_id']==0 and not calls


@pytest.mark.parametrize('change',['model','labels','cancel','stop','expired','session','preset'])
def test_class_selection_is_invalidated_before_approval(voice_class,change):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    hear('로봇 탐지 포장',1);hear('상품',2);identifier=v.pending['approval_id']
    if change=='model':catalog['model_version']='v2'
    elif change=='labels':catalog['classes'][0]['name']='새 상품'
    elif change=='cancel':client.post('/api/robot/preset-voice/cancel',json={})
    elif change=='stop':client.post('/api/robot/stop',json={})
    elif change=='expired':v.class_request['choice']['deadline']=time.monotonic()-1
    elif change=='session':v.session='replacement'
    else:p['name']='다른 설정';client.put(f'{BASE}/{p["id"]}',json=p)
    result=client.post('/api/robot/preset-voice/approve',json=dict(approval_id=identifier))
    assert result.status_code in {409,412} and not calls and not v.simulation


def test_old_or_same_class_event_cannot_confirm_execution(voice_class):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    p['confirmation']='voice';client.put(f'{BASE}/{p["id"]}',json=p)
    hear('로봇 탐지 포장',5)
    hear('상품',4);assert v.pending is None
    hear('상품',6)
    with pytest.raises(DomainError):hear('로봇 실행',6)
    assert v.pending and not calls
    hear('로봇 실행',7);assert v.simulation and not v.pending


def test_typed_class_test_is_isolated_and_cannot_mint_hardware_proof(voice_class):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    v.target='hardware';hear('로봇 탐지 포장',1)
    before=copy.deepcopy(v.status()['class_request'])
    result=client.post('/api/robot/preset-voice/test',json=dict(text='로봇 탐지 포장',class_name='상품'))
    assert result.status_code==200,result.text
    assert result.json()['simulation_only'] and result.json()['recipe']['detected']
    assert v.class_request['request_id']==before['request_id'] and v.class_request['choice'] is None
    snap=capture(client,p)
    response=client.post(f'{BASE}/{p["id"]}/execution-preview',json=dict(revision=p['revision'],snapshot_id=snap['snapshot_id'],candidate_id=snap['selected_id']))
    assert response.status_code==409 and not calls and not v.engine.robot.picks.approvals
    assert client.post('/api/robot/preset-voice/class-request',json=dict(preset_id=p['id'],revision=p['revision'],class_id=0)).status_code==422


def test_simulation_class_proof_cannot_be_used_for_hardware(voice_class):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    hear('로봇 탐지 포장',1);hear('상품',2);binding=v.pending['binding']
    result=client.post(f'{BASE}/{p["id"]}/execution-preview',json=dict(revision=p['revision'],snapshot_id=binding['snapshot_id'],candidate_id=binding['candidate_id']))
    assert result.status_code==409 and not calls


def test_spoken_class_scope_cannot_expand_to_whole_path(voice_class):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    v.target='hardware';step=p['steps'][2]['id']
    client.portal.call(v.begin_class,p,step);hear('상품',2)
    assert v.pending['total_steps']==5
    binding=v.pending['binding']
    result=client.post(f'{BASE}/{p["id"]}/execution-preview',json=dict(revision=p['revision'],snapshot_id=binding['snapshot_id'],candidate_id=binding['candidate_id']))
    assert result.status_code==409 and not calls


def test_generic_approval_cannot_bypass_voice_confirmation(voice_class):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    p['confirmation']='voice';client.put(f'{BASE}/{p["id"]}',json=p)
    v.target='hardware';hear('로봇 탐지 포장',1);hear('상품',2)
    result=client.post(BASE+'/executions/approve',json=dict(approval_id=v.pending['hardware_id']))
    assert result.status_code==409 and not calls


def test_stop_during_catalog_read_cannot_resurrect_a_class_request(voice_class,monkeypatch):
    client,calls,frame,catalog,p,v,hear,_=voice_class
    entered=threading.Event();release=threading.Event()
    def read():entered.set();assert release.wait(3);return catalog
    monkeypatch.setattr('app.robot_presets.read_yolo_catalog',read)
    async def run():
        task=asyncio.create_task(v.begin_class(p))
        try:
            assert await asyncio.to_thread(entered.wait,2)
            v.engine.robot.scenario.stop_all()
        finally:release.set()
        await task
        assert v.class_request is None and v.pending is None and not calls
    client.portal.call(run)


def test_catalog_normalization_collision_is_not_a_valid_voice_choice():
    catalog=dict(model_version='v1',classes=[dict(id=0,name='스팸'),dict(id=1,name='스 팸')])
    with pytest.raises(DomainError):match_class(catalog,'스팸')
