"""Module CRUD, protected defaults, shared TCP and live, version-bound path resolution."""
import copy

from tests.test_robot_scenario import scenario
from tests.test_robot_presets import BASE,library,ready
from tests.test_preset_yolo import yolo,capture,bound

MODULES='/api/robot/modules'


def modules(client):return client.get(MODULES).json()['modules']
def body(m):return {k:copy.deepcopy(m[k]) for k in ('name','kind','description','default_percent','settings','revision')}
def update(client,m):
    response=client.put(MODULES+'/'+m['id'],json=body(m));assert response.status_code==200,response.text
    return response.json()
def preview(client,p,**flags):
    response=client.post(BASE+'/'+p['id']+'/preview',json=dict(preset=p,**flags));assert response.status_code==200,response.text
    return response.json()
def box_update(client,**values):
    box=client.get('/api/robot/parcel-box').json();payload={k:box[k] for k in ('revision','size_mm','center_base_mm','tcp_pose','clearance_mm')};payload.update(values)
    result=client.put('/api/robot/parcel-box',json=payload);assert result.status_code==200,result.text
    return result.json()


def test_default_modules_are_readable_editable_and_cannot_be_deleted_or_unprotected(scenario):
    client,calls,*_=scenario;p=library(client)[0];items=modules(client)
    assert [m['id'] for m in items]==['builtin-standby','builtin-grasp','builtin-place']
    assert all(m['builtin'] for m in items)
    for m in items:
        assert client.get(MODULES+'/'+m['id']).json()==m
        assert client.request('DELETE',MODULES+'/'+m['id'],json=dict(revision=m['revision'])).status_code==409
        m['description']='기본 모듈 설명 수정';saved=update(client,m);assert saved['description']==m['description'] and saved['builtin']
        forged=body(saved);forged['builtin']=False
        assert client.put(MODULES+'/'+m['id'],json=forged).status_code==422
    assert all(s.get('module_id') for s in p['steps'] if s['kind'] in {'prepare','grasp','place'}) and not calls


def test_user_module_crud_and_per_instance_linking(scenario):
    client,calls,*_=scenario;p=library(client)[0];base=modules(client)[0];data=body(base)
    data.update(name='사용자 대기 자세',revision=None,default_percent=30);data['settings']['joints']=[-10,0,90,0,90,0]
    result=client.post(MODULES,json=data);assert result.status_code==201,result.text
    custom=result.json();assert not custom['builtin']
    custom['name']='수정된 대기 모듈';custom=update(client,custom)
    p['steps'][0]['module_id']=custom['id'];saved=client.put(BASE+'/'+p['id'],json=p).json()
    recipe=preview(client,saved);assert recipe['steps'][0]['target']==[-10,0,90,0,90,0]
    assert recipe['steps'][15]['target']==base['settings']['joints']
    assert client.request('DELETE',MODULES+'/'+custom['id'],json=dict(revision=custom['revision'])).status_code==409
    saved['steps'][0]['module_id']=base['id'];assert client.put(BASE+'/'+p['id'],json=saved).status_code==200
    assert client.request('DELETE',MODULES+'/'+custom['id'],json=dict(revision=custom['revision'])).status_code==200
    assert client.get(MODULES+'/'+custom['id']).status_code==404 and len(modules(client))==3 and not calls


def test_default_standby_edit_updates_all_linked_instances_and_invalidates_approval(scenario):
    client,calls,*_=scenario;p=library(client)[0];ticket=ready(client,p);m=modules(client)[0]
    m['settings'].update(joints=[5,0,90,0,90,0],opening_mm=70);saved=update(client,m)
    recipe=preview(client,p)
    assert recipe['steps'][0]['target']==recipe['steps'][15]['target']==[5,0,90,0,90,0]
    assert recipe['steps'][1]['opening_mm']==recipe['steps'][16]['opening_mm']==70
    assert client.post(BASE+'/executions/approve',json=dict(approval_id=ticket['approval_id'])).status_code in {409,412}
    assert client.put(MODULES+'/'+m['id'],json=body(m)).status_code==412
    assert saved['revision']!=m['revision'] and not calls


def test_yolo_geometry_uses_the_linked_grasp_definition(scenario):
    client,calls,frame,*_=scenario;p=yolo(client);m=next(m for m in modules(client) if m['kind']=='grasp')
    m['settings']['approaches']['floor']['distance_mm']=150;m['settings']['grasp_abc']['floor']=[90,180,0];update(client,m)
    snapshot=capture(client,p);recipe=bound(client,p,snapshot)
    assert not recipe['errors'];assert recipe['pose'][3:]==[90,180,0]
    assert recipe['approach'][2]==recipe['pose'][2]+150
    assert recipe['steps'][2]['target']==recipe['steps'][6]['target']==recipe['approach']
    assert not calls


def test_shared_box_is_the_only_drop_goal_for_simulation_and_hardware(scenario):
    client,calls,*_=scenario;p=library(client)[0]
    common=box_update(client,tcp_pose=[-480,10,130,0,180,0],clearance_mm=170)
    p['box_pose']=[123,456,789,0,0,0];p['context']['box_clearance_mm']=20
    for flags in ({},{'simulation_defaults':True}):
        recipe=preview(client,p,**flags)
        assert recipe['steps'][10]['target']==common['tcp_pose']
        assert recipe['steps'][9]['target']==recipe['steps'][12]['target']==[-480,10,300,0,180,0]
        assert recipe['box_revision']==common['revision']
    saved=client.put(BASE+'/'+p['id'],json=p).json();ticket=ready(client,saved)
    assert ticket['steps'][10]['target']==common['tcp_pose'] and not calls
    # Old geometry-only clients cannot accidentally erase the newly unified goal.
    response=client.put('/api/robot/parcel-box',json={k:common[k] for k in ('revision','size_mm','center_base_mm')})
    assert response.status_code==200 and response.json()['tcp_pose']==common['tcp_pose'] and response.json()['clearance_mm']==170


def test_missing_shared_tcp_never_falls_back_to_old_preset_tcp_for_real_jobs(scenario):
    client,calls,*_=scenario;p=library(client)[0];box_update(client,tcp_pose=None)
    assert p['box_pose'] is not None
    assert preview(client,p)['errors']
    virtual=preview(client,p,simulation_defaults=True);assert not virtual['errors'] and virtual['simulation_defaults']
    assert client.post(BASE+'/'+p['id']+'/execution-preview',json=dict(revision=p['revision'])).status_code==409
    assert client.get('/api/robot/parcel-box').json()['tcp_pose'] is None and not calls
