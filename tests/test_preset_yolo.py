"""YOLO-bound presets use synthetic camera and SDK owners only."""
import asyncio
import copy
import time
import threading

import pytest

from tests.test_robot_scenario import scenario,wait_state
from tests.test_robot_presets import BASE,library
from app.store import DomainError


@pytest.fixture(autouse=True)
def catalog(monkeypatch):
    monkeypatch.setattr('app.robot_presets.read_yolo_catalog',lambda:dict(model_version='v1',model_name='테스트 모델',classes=[dict(id=0,name='상품'),dict(id=1,name='다른 상품')]))
    fake_voice(monkeypatch)


def yolo(client,**changes):
    p=library(client)[0]
    p.update(object_source='yolo',yolo=dict(model_version='v1',class_id=0,class_label='상품',min_confidence=.8,selection='unique'))
    p.update(changes)
    result=client.put(f'{BASE}/{p["id"]}',json=p)
    assert result.status_code==200,result.text
    return result.json()


def capture(client,p,**body):
    response=client.post(f'{BASE}/{p["id"]}/detections',json=dict(revision=p['revision'],**body))
    assert response.status_code==200,response.text
    return response.json()


def voice_capture(client,p):
    v=client.app.state.robot.presets.voice
    async def run():
        v.session='asr';v.target='hardware'
        await v.begin_class(p)
        await v.hear(dict(text=p['yolo']['class_label'],sequence=2))
        assert v.pending
        return v.engine.detections.public(v.engine.detections.snapshots[v.pending['binding']['snapshot_id']])
    return client.portal.call(run)


def bound(client,p,snap,path='preview',**extra):
    v=client.app.state.robot.presets.voice
    if path=='execution-preview' and v.pending and v.pending.get('binding',{}).get('snapshot_id')==snap['snapshot_id']:
        target=v.engine.robot.picks.approvals[v.pending['hardware_id']]
        return dict(approval_id=v.pending['hardware_id'],total_steps=len(target['steps']),steps=copy.deepcopy(target['steps']),detected=copy.deepcopy(v.pending['detected']))
    response=client.post(f'{BASE}/{p["id"]}/{path}',json=dict(revision=p['revision'],snapshot_id=snap['snapshot_id'],candidate_id=snap['selected_id'],**extra))
    assert response.status_code==200,response.text
    return response.json()


def test_saved_default_and_yolo_capture_never_overwrite_saved_coordinates(scenario):
    client,calls,frame,*_=scenario
    assert library(client)[0]['object_source']=='saved'
    p=yolo(client);original=copy.deepcopy(p);frame['objects'][0]['xyxy']=[70,55,110,105]
    snapshot=capture(client,p);assert snapshot['state']=='selected' and not calls
    recipe=bound(client,p,snapshot)
    assert not recipe['errors'] and len(recipe['steps'])==17
    assert [s['calculation_source'] for s in recipe['steps']]==['standby']*2+['object']*5+[None]*2+['box']*4+[None]*2+['standby']*2
    assert [s['number'] for s in recipe['steps'] if not s['computed']]==[8,9,14,15]
    assert recipe['pose']==[-440,0,20,0,180,0]
    assert recipe['steps'][2]['target']==recipe['approach']
    assert recipe['steps'][4]['target']==recipe['pose']
    assert recipe['steps'][3]['opening_mm']==recipe['steps'][11]['opening_mm']==50
    assert recipe['steps'][7]['target']==p['context']['waypoint1_joints']
    assert recipe['steps'][10]['target']==p['box_pose']
    assert recipe['product']['size_mm']==[40,50,40]  # Normal-axis depth stays configured.
    assert client.get(f'{BASE}/{p["id"]}').json()==original
    assert not calls and not client.app.state.robot.picks.approvals


@pytest.mark.parametrize('policy,count', [('unique',2),('manual',1)])
def test_multiple_or_manual_candidates_require_explicit_selection(scenario,policy,count):
    client,calls,frame,*_=scenario;p=yolo(client)
    p['yolo']['selection']=policy;p=client.put(f'{BASE}/{p["id"]}',json=p).json()
    if count==2:frame['objects'].append(dict(class_id=0,label='상품',confidence=.95,xyxy=[110,50,130,70]))
    snapshot=capture(client,p);assert snapshot['state']=='selection_required' and snapshot['selected_id'] is None
    result=client.post(f'{BASE}/{p["id"]}/preview',json=dict(snapshot_id=snapshot['snapshot_id']))
    assert result.status_code==409
    snapshot['selected_id']=snapshot['candidates'][-1]['id']
    assert not bound(client,p,snapshot)['errors']
    assert not calls and not client.app.state.robot.picks.approvals


@pytest.mark.parametrize('change', ['none','class','confidence','outside','cropped'])
def test_no_match_and_invalid_boxes_never_create_hardware_approval(scenario,change):
    client,calls,frame,*_=scenario;p=yolo(client)
    if change=='none':frame['objects']=[]
    elif change=='class':frame['objects'][0]['class_id']=3
    elif change=='confidence':frame['objects'][0]['confidence']=.6
    elif change=='outside':frame['objects'][0]['xyxy']=[200,190,220,210]
    else:frame['objects'][0]['xyxy']=[0,50,100,100]
    snapshot=capture(client,p)
    assert snapshot['state']=='no_match'
    response=client.post(f'{BASE}/{p["id"]}/execution-preview',json=dict(revision=p['revision'],snapshot_id=snapshot['snapshot_id']))
    assert response.status_code==409 and not calls
    assert not client.app.state.robot.picks.approvals


def test_yolo_without_a_snapshot_cannot_fall_back_to_saved_object(scenario):
    client,calls,*_=scenario;p=yolo(client)
    recipe=client.post(f'{BASE}/{p["id"]}/preview',json={}).json()
    assert recipe['errors'] and recipe['pose'] is None and recipe['steps'][4]['target'] is None
    response=client.post(f'{BASE}/{p["id"]}/execution-preview',json=dict(revision=p['revision']))
    assert response.status_code==409 and not calls


@pytest.mark.parametrize('change', ['expired','stop','preset','calibration','other_preset'])
def test_snapshots_are_bound_to_conditions_versions_and_stop_generation(scenario,change):
    client,calls,*_=scenario;p=yolo(client);snap=capture(client,p);robot=client.app.state.robot
    if change=='expired':robot.presets.detections.snapshots[snap['snapshot_id']]['deadline']=time.monotonic()-1
    elif change=='stop':client.post('/api/robot/stop',json={})
    elif change=='preset':p['name']='변경';p=client.put(f'{BASE}/{p["id"]}',json=p).json()
    elif change=='calibration':
        c=client.get('/api/robot/pick/calibration?region=floor').json();c['clearance_per_side_mm']=6
        client.put('/api/robot/pick/calibration',json=c)
    else:p=client.post(f'{BASE}/{p["id"]}/copy',json=dict(revision=p['revision'])).json()
    response=client.post(f'{BASE}/{p["id"]}/execution-preview',json=dict(revision=p['revision'],snapshot_id=snap['snapshot_id'],candidate_id=snap['selected_id']))
    assert response.status_code in {409,412} and not calls


@pytest.mark.parametrize('change', ['lost','duplicate','model','camera','confidence','wider'])
def test_camera_changes_after_approval_prevent_any_motion(scenario,change):
    client,calls,frame,*_=scenario;p=yolo(client);snap=voice_capture(client,p);ticket=bound(client,p,snap,'execution-preview')
    if change=='lost':frame['objects']=[]
    elif change=='duplicate':frame['objects']*=2
    elif change=='model':frame['model_version']='v2'
    elif change=='camera':frame['camera_generation']=2
    elif change=='confidence':frame['objects'][0]['confidence']=.3
    else:frame['objects'][0]['xyxy']=[50,50,110,110]
    response=client.post(BASE+'/executions/approve',json=dict(approval_id=ticket['approval_id']))
    assert response.status_code==202,response.text
    assert wait_state(client,ticket['approval_id'],{'completed','failed','unknown'})['state']=='failed'
    assert not calls


def test_full_yolo_route_runs_in_order_and_stops_reading_camera_after_grip(scenario,monkeypatch):
    client,calls,frame,*_=scenario;p=yolo(client);snap=voice_capture(client,p);ticket=bound(client,p,snap,'execution-preview')
    import app.robot_scenario as module
    original=module.request_host
    def host(operation,*args):
        result=original(operation,*args)
        if operation=='operation' and args[-1].kind=='gripper' and args[-1].contact_ma:
            frame['objects']=[]
        return result
    monkeypatch.setattr(module,'request_host',host)
    assert client.post(BASE+'/executions/approve',json=dict(approval_id=ticket['approval_id'])).status_code==202
    move=wait_state(client,ticket['approval_id'],{'completed','failed','unknown'})
    assert move['state']=='completed',move
    assert len(calls)==17 and calls[3].position==calls[11].position
    assert move['detected']['snapshot_id']==snap['snapshot_id']


def test_preparation_has_separate_approval_and_does_not_need_detection(scenario):
    client,calls,frame,status,hand,*_=scenario;p=yolo(client);hand['position']=200
    assert client.post(f'{BASE}/{p["id"]}/detections',json=dict(revision=p['revision'],hardware=True)).status_code==409
    assert not calls
    ticket=client.post(f'{BASE}/{p["id"]}/recognition-preview',json=dict(revision=p['revision']))
    assert ticket.status_code==200,ticket.text
    ticket=ticket.json();assert ticket['recognition_prepare'] and len(ticket['steps'])==2 and not calls
    client.post(BASE+'/executions/approve',json=dict(approval_id=ticket['approval_id']))
    assert wait_state(client,ticket['approval_id'],{'completed','failed','unknown'})['state']=='completed'
    assert len(calls)==2 and voice_capture(client,p)['selected_id']


def enable_voice(client,p,confirmation='screen'):
    p.update(voice_enabled=True,aliases=['로봇 탐지 포장'],confirmation=confirmation)
    response=client.put(f'{BASE}/{p["id"]}',json=p);assert response.status_code==200,response.text
    return response.json()


def fake_voice(monkeypatch):
    monkeypatch.setattr('app.robot_preset_voice.native_voice',lambda *a,**kw:dict(session_id='asr',context='robot',cursor=1,state='listening',events=[]))


def test_yolo_sentence_test_cannot_create_or_use_real_approval(scenario,monkeypatch):
    client,calls,*_=scenario;p=enable_voice(client,yolo(client));v=client.app.state.robot.presets.voice
    v.target='hardware';fake_voice(monkeypatch)
    result=client.post('/api/robot/preset-voice/test',json=dict(text='로봇 탐지 포장',class_name='상품'))
    assert result.status_code==200,result.text
    result=result.json();assert result['simulation_only'] and result['recipe']['detected']
    assert v.pending is None and not calls and not client.app.state.robot.picks.approvals
    assert client.post('/api/robot/preset-voice/test',json=dict(text='로봇 실행')).status_code==409


@pytest.mark.parametrize('target',['simulation','hardware'])
def test_voice_manual_choice_requires_selection_then_fresh_voice_confirmation(scenario,monkeypatch,target):
    client,calls,frame,*_=scenario;p=enable_voice(client,yolo(client),'voice')
    frame['objects'].append(dict(class_id=0,label='상품',confidence=.95,xyxy=[110,50,130,70]))
    v=client.app.state.robot.presets.voice;fake_voice(monkeypatch)
    async def run():
        v.session='asr';v.target=target;v.ui_seen=time.monotonic()
        await v.hear(dict(text='로봇 탐지 포장',sequence=1))
        await v.hear(dict(text='상품',sequence=2))
        assert v.pending is None and v.selection and not calls
        with pytest.raises(DomainError):await v.hear(dict(text='로봇 실행',sequence=2))
        choice=v.selection;cid=choice['detection']['candidates'][0]['id']
        await v.select(choice['request_id'],cid)
        assert not v.selection and v.pending and not calls
        assert v.status()['pending']['detected']['candidate_id']==cid
        assert 'recipe' not in v.status()['pending'] and 'binding' not in v.status()['pending']
        with pytest.raises(DomainError):await v.hear(dict(text='로봇 실행',sequence=1))
        with pytest.raises(DomainError):await v.confirm(v.pending['approval_id'])
        await v.hear(dict(text='로봇 실행',sequence=3))
        move=copy.deepcopy(v.engine.robot.picks.moves.get(v.engine.robot.picks.active_id))
        assert v.pending is None
        if target=='simulation':assert v.simulation['recipe']['detected']['candidate_id']==cid and not calls
        v.session=None
        return move
    move=client.portal.call(run)
    if target=='hardware':
        assert wait_state(client,move['approval_id'],{'completed','failed','unknown'})['state']=='completed'
        assert len(calls)==17


def test_sentence_manual_choice_remains_isolated_from_voice_pending(scenario,monkeypatch):
    client,calls,frame,*_=scenario;p=enable_voice(client,yolo(client));p['yolo']['selection']='manual'
    p=client.put(f'{BASE}/{p["id"]}',json=p).json();v=client.app.state.robot.presets.voice;fake_voice(monkeypatch)
    async def begin():
        v.session='asr';await v.hear(dict(text='로봇 탐지 포장',sequence=1));await v.hear(dict(text='상품',sequence=2))
        await v.hear(dict(text='상품',sequence=2))
    client.portal.call(begin);pending=copy.deepcopy(v.status()['selection'])
    result=client.post('/api/robot/preset-voice/test',json=dict(text='로봇 탐지 포장',class_name='상품')).json()
    assert result['recipe'] is None and result['detection']['state']=='selection_required'
    result=client.post('/api/robot/preset-voice/test',json=dict(text='로봇 탐지 포장',snapshot_id=result['detection']['snapshot_id'],candidate_id=result['detection']['candidates'][0]['id'])).json()
    assert result['recipe']['detected'] and v.status()['selection']==pending and v.pending is None
    assert not calls and not client.app.state.robot.picks.approvals
    client.portal.call(v.stop,False)


def test_stop_during_camera_read_never_publishes_voice_selection(scenario,monkeypatch):
    client,calls,frame,*_=scenario;p=enable_voice(client,yolo(client));v=client.app.state.robot.presets.voice
    entered=threading.Event();release=threading.Event();fake_voice(monkeypatch)
    def camera(*args):entered.set();assert release.wait(3);return copy.deepcopy(frame)
    monkeypatch.setattr('app.robot_pick.read_camera',camera)
    async def run():
        v.session='asr';await v.begin_class(p);task=asyncio.create_task(v.hear(dict(text='상품',sequence=2)))
        try:
            assert await asyncio.to_thread(entered.wait,2)
            v.engine.robot.scenario.stop_all()
        finally:release.set()
        await task
        assert v.pending is None and v.selection is None
        v.session=None
    client.portal.call(run);assert not calls


def test_camera_motion_between_preopen_and_descent_sends_no_descent(scenario,monkeypatch):
    client,calls,frame,*_=scenario;p=yolo(client);snap=voice_capture(client,p);ticket=bound(client,p,snap,'execution-preview')
    import app.robot_scenario as module
    original=module.request_host
    def host(operation,*args):
        result=original(operation,*args)
        if operation=='operation' and len(calls)==4:frame['objects']=[]
        return result
    monkeypatch.setattr(module,'request_host',host)
    client.post(BASE+'/executions/approve',json=dict(approval_id=ticket['approval_id']))
    assert wait_state(client,ticket['approval_id'],{'completed','failed','unknown'})['state']=='failed'
    assert len(calls)==4 and calls[-1].kind=='gripper'


def test_partial_range_still_needs_detection_and_never_accepts_client_coordinates(scenario):
    client,calls,*_=scenario;p=yolo(client);grasp=next(s for s in p['steps'] if s['kind']=='grasp')
    p.update(range_start=grasp['id'],range_end=grasp['id']);p=client.put(f'{BASE}/{p["id"]}',json=p).json()
    snap=voice_capture(client,p);ticket=bound(client,p,snap,'execution-preview')
    assert ticket['total_steps']==5 and ticket['detected']
    assert client.post(f'{BASE}/{p["id"]}/execution-preview',json=dict(revision=p['revision'],pose=[0]*6)).status_code==422
    assert not calls


def test_shelf_target_uses_taught_orientation_and_normal_and_keeps_configured_depth(scenario):
    client,calls,frame,*_=scenario
    calibration=client.get('/api/robot/pick/calibration?region=floor').json()
    calibration.update(region='shelf',revision=None)
    for corner,xyz in zip(calibration['corners'],[[-450,-70,200],[-450,70,200],[-450,70,340],[-450,-70,340]]):
        corner['pixel'][0]+=155;corner['pose']=[*xyz,180,90,90]
    assert client.put('/api/robot/pick/calibration',json=calibration).status_code==200
    p=yolo(client,region='shelf');p['context']['virtual']['shelf']['size_mm']=[65,35,45]
    p=client.put(f'{BASE}/{p["id"]}',json=p).json()
    frame['objects'][0]['xyxy']=[205,60,245,100]
    snapshot=capture(client,p);recipe=bound(client,p,snapshot)
    assert recipe['pose']==pytest.approx([-450,-10,270,180,90,90])
    assert recipe['approach'][:3]==pytest.approx([-350,-10,270])
    assert recipe['product']['size_mm']==pytest.approx([65,40,40])
    assert recipe['opening_mm']==pytest.approx(50)
    assert not calls


def test_overlapping_work_planes_do_not_auto_select_a_yolo_target(scenario):
    client,calls,*_=scenario
    calibration=client.get('/api/robot/pick/calibration?region=floor').json()
    calibration.update(region='shelf',revision=None)
    for corner,xyz in zip(calibration['corners'],[[-450,-70,200],[-450,70,200],[-450,70,340],[-450,-70,340]]):corner['pose']=[*xyz,180,90,90]
    assert client.put('/api/robot/pick/calibration',json=calibration).status_code==200
    p=yolo(client);snapshot=capture(client,p)
    assert snapshot['selected_id'] is None and snapshot['state']=='no_match'
    assert '겹칩니다' in snapshot['candidates'][0]['reason'] and not calls
