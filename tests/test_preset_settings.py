"""Preset-owned pose and preview data never mutate camera registration or hardware targets."""
import copy

import pytest

from tests.test_robot_scenario import scenario
from tests.test_robot_presets import BASE,library,ready
from tests.test_preset_yolo import yolo,capture,bound
from tests.test_robot_camera_calibration import solved


def save(client,p):
    response=client.put(BASE+'/'+p['id'],json=p)
    assert response.status_code==200,response.text
    return response.json()


def test_custom_orientation_is_independent_saved_and_used_for_box_width(scenario):
    client,calls,*_=scenario;p=library(client)[0]
    original=client.post(BASE+'/'+p['id']+'/preview',json={}).json()
    planes=copy.deepcopy(client.app.state.robot.picks.planes)
    p['context']['virtual']['floor']['size_mm']=[40,60,40]
    p['grasp_abc']['floor']=[90.,180.,0.]
    p=save(client,p)
    preview=client.post(BASE+'/'+p['id']+'/preview',json={}).json()
    assert not preview['errors'] and preview['pose'][3:]==[90.,180.,0.]
    assert preview['opening_mm']==pytest.approx(70)
    assert preview['approach'][3:]==preview['pose'][3:]
    assert client.app.state.robot.picks.planes==planes
    copied=client.post(BASE+'/'+p['id']+'/copy',json=dict(revision=p['revision'])).json()
    copied['grasp_abc']['floor']=[0.,180.,0.];copied=save(client,copied)
    assert client.get(BASE+'/'+p['id']).json()['grasp_abc']['floor']==[90.,180.,0.]
    assert original['pose'][3:]==[0,180,0] and not calls


def test_xyz_only_camera_registration_uses_preset_orientation(scenario):
    client,calls,*_=scenario;robot=client.app.state.robot;p=yolo(client)
    calibration=client.get('/api/robot/pick/calibration?region=floor').json()
    for corner in calibration['corners']:corner['pose'][3:]=[None,None,None]
    response=client.put('/api/robot/pick/calibration',json=calibration)
    assert response.status_code==200,response.text
    p['grasp_abc']['floor']=[90.,180.,0.];p=save(client,p)
    snap=capture(client,p);preview=bound(client,p,snap)
    assert preview['pose'][3:]==[90.,180.,0.] and not calls
    for corner in calibration['corners']:corner['pose'][0]=None
    assert client.put('/api/robot/pick/calibration',json=calibration).status_code==422


def test_yolo_plane_orientation_rotates_opening_without_modifying_plane(scenario):
    client,calls,frame,*_=scenario;frame['objects'][0]['xyxy']=[60,60,90,110]
    p=yolo(client);before=copy.deepcopy(client.app.state.robot.picks.planes)
    p['grasp_abc']['floor']=[90.,180.,0.];p=save(client,p)
    snap=capture(client,p);preview=bound(client,p,snap)
    assert preview['opening_mm']==pytest.approx(60)
    assert preview['pose'][3:]==[90.,180.,0.]
    assert client.app.state.robot.picks.planes==before and not calls


def test_depth_target_uses_preset_tool_axis(scenario,monkeypatch):
    client,calls,*_=scenario;solved(monkeypatch,client)
    monkeypatch.setattr('app.robot_camera_calibration.native_call',lambda *args:dict(surface_base_mm=[-450.,0.,40.],
        points_base_mm=[[-465.,-25.,40.],[-435.,25.,40.]],bbox_base_mm=[[-465.,-25.,40.],[-435.,25.,40.]],depth_mm=700.))
    p=yolo(client);p['grasp_abc']['floor']=[90.,180.,0.];p=save(client,p)
    snap=capture(client,p);preview=bound(client,p,snap)
    assert preview['opening_mm']==pytest.approx(60) and preview['pose'][3:]==[90.,180.,0.] and not calls


@pytest.mark.parametrize('shift',[-8.,8.])
def test_tilted_depth_grasp_revalidates_hidden_face_about_approved_tcp(scenario,monkeypatch,shift):
    client,calls,*_=scenario;solved(monkeypatch,client);delta=0.
    def native(*_):
        points=[[-465.+delta,-25.,40.],[-435.+delta,25.,40.]]
        return dict(surface_base_mm=[-450.+delta,0.,40.],points_base_mm=points,bbox_base_mm=points,depth_mm=700.)
    monkeypatch.setattr('app.robot_camera_calibration.native_call',native)
    p=yolo(client);p['grasp_abc']['floor']=[0.,135.,0.];p=save(client,p)
    snap=capture(client,p)
    assert not bound(client,p,snap)['errors']
    delta=shift
    response=client.post(BASE+'/'+p['id']+'/preview',json=dict(snapshot_id=snap['snapshot_id']))
    assert response.status_code==409,response.text
    assert '벌림' in response.json()['detail'] and not calls


def test_mock_object_persists_but_hardware_ignores_it(scenario):
    client,calls,*_=scenario;p=library(client)[0];original=copy.deepcopy(p['context']['virtual'])
    p['simulation_objects']['floor']=dict(center_base_mm=[-420.,10.,30.],size_mm=[30.,50.,60.]);p=save(client,p)
    simulated=client.post(BASE+'/'+p['id']+'/preview',json=dict(simulation_object=True)).json()
    physical=client.post(BASE+'/'+p['id']+'/preview',json={}).json()
    assert simulated['example'] and simulated['pose'][:3]==[-420.,10.,30.]
    assert physical.get('example') is not True and physical['pose'][:3]==original['floor']['center_base_mm']
    ticket=ready(client,p)
    descent=next(s for s in ticket['steps'] if s.get('object_role')=='descent')
    assert descent['target'][:3]==original['floor']['center_base_mm']
    assert client.get(BASE+'/'+p['id']).json()['context']['virtual']==original and not calls
    response=client.post(BASE+'/'+p['id']+'/execution-preview',json=dict(revision=p['revision'],simulation_object=True))
    assert response.status_code==422 and not calls


def test_mock_yolo_preview_never_bypasses_voice_or_creates_approval(scenario):
    client,calls,*_=scenario;p=yolo(client)
    p['simulation_objects']['floor']=dict(center_base_mm=[-430.,0.,20.],size_mm=[40.,40.,40.]);p=save(client,p)
    response=client.post(BASE+'/'+p['id']+'/preview',json=dict(simulation_object=True))
    assert response.status_code==200 and response.json()['example']
    assert not client.app.state.robot.picks.approvals and not calls
    assert client.post(BASE+'/'+p['id']+'/execution-preview',json=dict(revision=p['revision'])).status_code==409
    actual=client.post(BASE+'/'+p['id']+'/preview',json={}).json()
    assert actual['errors'] and actual['pose'] is None


@pytest.mark.parametrize('field,value',[('grasp_abc',dict(floor=[1.,2.],shelf=None)),('simulation_objects',dict(floor=dict(center_base_mm=[0.,0.,0.],size_mm=[-1.,20.,30.]),shelf=None))])
def test_incomplete_pose_and_invalid_mock_geometry_are_rejected(scenario,field,value):
    client,*_=scenario;p=library(client)[0];p[field]=value
    assert client.put(BASE+'/'+p['id'],json=p).status_code==422
