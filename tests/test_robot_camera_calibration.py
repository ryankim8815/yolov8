import asyncio
import copy
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from app.robot_camera_calibration import CameraCalibration,MarkerConfig,joints
from app.store import DomainError
from tests.test_robot_scenario import scenario,wait_state
from tests.test_robot_presets import create,ready
from tests.test_preset_yolo import yolo,capture,bound,fake_voice,voice_capture

BASE='/api/robot/camera-calibration'
CONFIG=dict(marker_id=0,side_mm=100.,corners_base_mm=[[0.,100.,0.],[100.,100.,0.],[100.,0.,0.],[0.,0.,0.]])
MULTI=dict(marker_ids=[0,1,2,3],side_mm=100.,corners_base_mm=[[0.,200.,0.],[300.,200.,0.],[300.,0.,0.],[0.,0.,0.]])


def register(client,**changes):
    value=client.get(BASE).json()
    result=client.put(BASE,json=dict(revision=value['revision'],enabled=True,config=copy.deepcopy(CONFIG),**changes))
    assert result.status_code==200,result.text
    return result.json()


def solved(monkeypatch,client):
    monkeypatch.setattr('app.robot_camera_calibration.joints',lambda _: [0.,0.,90.,0.,90.,0.])
    monkeypatch.setattr('app.robot_camera_calibration.native_call',lambda action,body:dict(token='a'*32,quality=dict(frames=12),camera=dict(width=640,height=480)))
    value=register(client)
    result=client.post(BASE+'/run',json=dict(revision=value['revision']))
    assert result.status_code==200,result.text
    return result.json()


def test_registration_conflict_geometry_and_existing_state_preserved(scenario):
    client,calls,*_=scenario;robot=client.app.state.robot
    original=[copy.deepcopy(robot.presets.library.load()),copy.deepcopy(robot.work_points.points),copy.deepcopy(robot.hand.table)]
    value=register(client)
    assert value['state']=='required' and value['result'] is None
    assert client.put(BASE,json=dict(revision=None,enabled=True,config=CONFIG)).status_code==412
    bad=copy.deepcopy(CONFIG);bad['corners_base_mm'][2][2]=10
    assert client.put(BASE,json=dict(revision=value['revision'],config=bad)).status_code==422
    assert [robot.presets.library.load(),robot.work_points.points,robot.hand.table]==original and not calls


def test_four_ids_and_center_coordinates_persist_and_reach_native_solver(scenario,monkeypatch):
    client,calls,*_=scenario;received=[]
    monkeypatch.setattr('app.robot_camera_calibration.joints',lambda _: [0.,0.,90.,0.,90.,0.])
    def native(action,body):received.append((action,body));return dict(token='a'*32)
    monkeypatch.setattr('app.robot_camera_calibration.native_call',native)
    response=client.put(BASE,json=dict(enabled=True,config=MULTI));assert response.status_code==200,response.text
    assert response.json()['config']==MULTI
    assert client.post(BASE+'/run',json=dict(revision=response.json()['revision'])).status_code==200
    assert received==[('solve',MULTI)] and not calls
    robot=client.app.state.robot;restored=CameraCalibration(robot,robot.pose_tests.path.parent)
    assert restored.status()['config']==MULTI and restored.status()['state']=='required'


@pytest.mark.parametrize('changes',[
    dict(marker_ids=[0,0,2,3]),dict(marker_ids=[0,1,2,50]),dict(marker_ids=[0,1,2]),dict(marker_id=1),
    dict(corners_base_mm=[[0.,0.,0.],[100.,0.,0.],[200.,0.,0.],[300.,0.,0.]]),
    dict(corners_base_mm=[[0.,0.,0.],[0.,0.,0.],[300.,0.,0.],[0.,200.,0.]])])
def test_invalid_multi_marker_registration_leaves_original_state_untouched(scenario,changes):
    client,calls,*_=scenario;before=client.get(BASE).json();config=copy.deepcopy(MULTI);config.update(changes)
    response=client.put(BASE,json=dict(config=config))
    assert response.status_code==422,response.text
    assert client.get(BASE).json()==before and not calls


def test_new_registration_revokes_hardware_and_voice_approvals(scenario):
    client,calls,*_=scenario;p=create(client,[dict(kind='wait',seconds=.1)]);ticket=ready(client,p)
    robot=client.app.state.robot;old=robot.scenario.versions()
    robot.presets.detections.snapshots['fake']={'value':1}
    register(client)
    assert robot.scenario.versions()!=old and not robot.picks.approvals and not robot.presets.detections.snapshots
    assert client.post('/api/robot/presets/executions/approve',json=dict(approval_id=ticket['approval_id'])).status_code==409
    assert not calls


def test_manual_calibration_success_does_not_move_robot_and_restart_requires_calibration(scenario,monkeypatch):
    client,calls,*_=scenario;value=solved(monkeypatch,client)
    assert value['state']=='ready' and value['result']['token']=='a'*32 and not calls
    robot=client.app.state.robot
    reloaded=CameraCalibration(robot,robot.pose_tests.path.parent)
    assert reloaded.status()['state']=='required' and reloaded.value['config']==CONFIG
    with pytest.raises(DomainError,match='필요'):reloaded.require_valid()


def test_robot_movement_or_global_stop_during_capture_prevents_commit(scenario,monkeypatch):
    client,calls,*_=scenario;value=register(client);started=threading.Event();release=threading.Event()
    monkeypatch.setattr('app.robot_camera_calibration.joints',lambda _: [0.,0.,90.,0.,90.,0.])
    def native(*args):started.set();release.wait(2);return dict(token='a'*32)
    monkeypatch.setattr('app.robot_camera_calibration.native_call',native)
    with ThreadPoolExecutor() as pool:
        request=pool.submit(client.post,BASE+'/run',json=dict(revision=value['revision']))
        assert started.wait(1)
        assert client.get(BASE).json()['busy']
        p=client.app.state.robot.presets.library.load()['presets'][0]
        assert client.put('/api/robot/presets/'+p['id'],json=p).status_code==409
        client.post('/api/robot/stop',json={});release.set()
        assert request.result().status_code==409
    assert client.get(BASE).json()['state']=='required' and not calls


def test_robot_joint_drift_rejects_calibration(scenario,monkeypatch):
    client,calls,*_=scenario;value=register(client);count=0
    def moving(_):
        nonlocal count
        count+=1;return [0. if count==1 else .3,0.,90.,0.,90.,0.]
    monkeypatch.setattr('app.robot_camera_calibration.joints',moving)
    def native(*_):threading.Event().wait(.2);return dict(token='a'*32)
    monkeypatch.setattr('app.robot_camera_calibration.native_call',native)
    response=client.post(BASE+'/run',json=dict(revision=value['revision']))
    assert response.status_code==409 and '자세' in response.json()['detail']
    assert client.get(BASE).json()['result'] is None and not calls


def test_calibrated_yolo_uses_exact_frame_depth_and_revalidates_before_execution(scenario,monkeypatch):
    client,calls,frame,*_=scenario
    fake_voice(monkeypatch)
    monkeypatch.setattr('app.robot_presets.read_yolo_catalog',lambda:dict(model_version='v1',model_name='테스트',classes=[dict(id=0,name='상품')]))
    solved(monkeypatch,client);robot=client.app.state.robot;requests=[];surface=[-450.,0.,40.]
    def native(action,body):
        requests.append((action,body))
        assert body['session_id']==frame['session_id'] and body['frame_id']==frame['frame_id'] and body['object_index']==0
        return dict(surface_base_mm=surface[:],points_base_mm=[[-470.,-20.,40.],[-430.,20.,40.]],bbox_base_mm=[[-470.,-20.,40.],[-430.,20.,40.]],depth_mm=700.)
    monkeypatch.setattr('app.robot_camera_calibration.native_call',native)
    p=yolo(client);snapshot=capture(client,p);recipe=bound(client,p,snapshot)
    assert recipe['pose']==[-450.,0.,20.,0.,180.,0.]
    assert snapshot['candidates'][0]['opening_mm']==pytest.approx(50)
    target=robot.presets.detections.snapshots[snapshot['snapshot_id']]['targets'][snapshot['selected_id']]
    assert target['resolved']['surface_base_mm']==surface and target['resolved']['thickness_source']=='preset'
    surface[0]+=20
    response=client.post('/api/robot/presets/'+p['id']+'/preview',json=dict(snapshot_id=snapshot['snapshot_id']))
    assert response.status_code==409 and '10 mm' in response.json()['detail']
    assert requests and not calls
    robot.camera_calibration.invalidate('새 보정 필요')
    assert client.post('/api/robot/presets/'+p['id']+'/detections',json=dict(revision=p['revision'])).status_code==412
    assert not calls


def test_unconfigured_or_stale_robot_telemetry_cannot_be_used_for_calibration(scenario):
    client,*_=scenario
    register(client)
    with pytest.raises(DomainError,match='수신'):joints(client.app.state.robot)


def test_late_view_cannot_invalidate_a_new_calibration(scenario,monkeypatch):
    client,*_=scenario;solved(monkeypatch,client);calibration=client.app.state.robot.camera_calibration
    def late(*_):
        calibration.value.update(revision='b'*32,result=dict(token='b'*32));calibration.valid=True
        return dict(error='이전 세션 종료',calibration=dict(token='a'*32))
    monkeypatch.setattr('app.robot_camera_calibration.native_call',late)
    value=client.portal.call(calibration.view)
    assert value['calibration'] is None and calibration.valid
    assert calibration.value['revision']=='b'*32


def test_registration_and_run_reject_cross_origin_requests(scenario):
    client,calls,*_=scenario
    response=client.put(BASE,json=dict(config=CONFIG),headers={'Origin':'https://untrusted.example'})
    assert response.status_code==403 and client.get(BASE).json()['revision'] is None and not calls


@pytest.mark.parametrize('region,axis',[('floor',0),('shelf',1)])
@pytest.mark.parametrize('shift',[-8.,8.])
def test_depth_revalidation_checks_opening_about_the_approved_tcp(scenario,monkeypatch,region,axis,shift):
    client,calls,frame,*_=scenario;fake_voice(monkeypatch)
    solved(monkeypatch,client)
    delta=[0.,0.,0.]
    surface=[-450.,0.,40.] if region=='floor' else [-450.,0.,300.]
    points=[[-470.,-20.,40.],[-430.,20.,40.]] if region=='floor' else [[-450.,-20.,280.],[-450.,20.,320.]]
    def native(*_):
        moved=lambda point:[point[i]+delta[i] for i in range(3)]
        return dict(surface_base_mm=moved(surface),points_base_mm=list(map(moved,points)),bbox_base_mm=list(map(moved,points)),depth_mm=700.)
    monkeypatch.setattr('app.robot_camera_calibration.native_call',native)
    p=yolo(client,region=region);snapshot=capture(client,p)
    assert snapshot['candidates'][0]['opening_mm']==pytest.approx(50)
    assert not bound(client,p,snapshot)['errors']
    delta[axis]=shift
    response=client.post('/api/robot/presets/'+p['id']+'/preview',json=dict(snapshot_id=snapshot['snapshot_id']))
    assert response.status_code==409,response.status_code
    assert '벌림' in response.json()['detail'] and not calls


def test_shift_after_approval_stops_before_the_first_sdk_operation(scenario,monkeypatch):
    client,calls,*_=scenario;fake_voice(monkeypatch)
    monkeypatch.setattr('app.robot_presets.read_yolo_catalog',lambda:dict(model_version='v1',model_name='테스트',classes=[dict(id=0,name='상품')]))
    solved(monkeypatch,client);shift=0.
    def native(*_):
        points=[[-470.+shift,-20.,40.],[-430.+shift,20.,40.]]
        return dict(surface_base_mm=[-450.+shift,0.,40.],points_base_mm=points,bbox_base_mm=points,depth_mm=700.)
    monkeypatch.setattr('app.robot_camera_calibration.native_call',native)
    p=yolo(client);snapshot=voice_capture(client,p)
    ticket=bound(client,p,snapshot,'execution-preview')
    assert not calls
    shift=8.
    response=client.post('/api/robot/presets/executions/approve',json=dict(approval_id=ticket['approval_id']))
    assert response.status_code==202,response.text
    move=wait_state(client,ticket['approval_id'],{'failed','unknown','cancelled','completed'})
    assert move['state']=='failed' and '벌림' in move['message'] and not calls
