"""Common carton geometry and temporary defaults remain preview-only."""
import copy

import pytest

from tests.test_robot_scenario import scenario
from tests.test_robot_presets import BASE, library, ready


def set_box(client,center,size,tcp_pose=None):
    current=client.get('/api/robot/parcel-box').json()
    response=client.put('/api/robot/parcel-box',json=dict(revision=current['revision'],center_base_mm=center,size_mm=size,tcp_pose=tcp_pose))
    assert response.status_code==200,response.text
    return response.json()


def preview(client,p,**kwargs):
    response=client.post(BASE+'/'+p['id']+'/preview',json=dict(preset=p,**kwargs))
    assert response.status_code==200,response.text
    return response.json()


@pytest.mark.parametrize('center,size',[([-500,0,0],[400,300,250]),([220,-110,35],[300,200,180])])
def test_every_virtual_mode_uses_current_common_carton_without_writes(scenario,center,size):
    client,calls,*_=scenario;p=library(client)[0]
    assert p['box_center']!=center
    common=set_box(client,center,size)
    p['simulation_objects']['floor']=dict(center_base_mm=[-420,10,30],size_mm=[30,50,60])
    directory=client.app.state.robot.presets.library.path.parent
    files={path:path.read_bytes() for path in directory.rglob('*.json')}
    for mock in [False,True]:
        recipe=preview(client,p,simulation_object=mock,simulation_defaults=True)
        assert recipe['box']==dict(center_base_mm=center,size_mm=size)
        assert recipe['box_source']=='parcel_box' and recipe['box_revision']==common['revision']
        assert recipe['box_pose'][:3]==[*center[:2],center[2]+min(120,size[2]/2)]
    for region in ['floor','shelf']:
        recipe=client.post('/api/robot/pick/scenario/preview',json=dict(example=True,region=region)).json()
        assert not recipe['errors'] and recipe['box']==dict(center_base_mm=center,size_mm=size)
        assert recipe['box_pose'][:3]==[*center[:2],center[2]+min(120,size[2]/2)]
        assert recipe['steps'][9]['target'][2]>=center[2]+size[2]+50
    assert {path:path.read_bytes() for path in directory.rglob('*.json')}==files and not calls
    changed=set_box(client,[center[0]+10,*center[1:]],size)
    assert preview(client,p)['box']['center_base_mm']==changed['center_base_mm']


def test_missing_teaching_uses_explicit_simulation_defaults_and_never_saves_them(scenario):
    client,calls,*_=scenario;p=library(client)[0]
    p['context']['waypoint1_joints']=None;p['box_pose']=None
    p['context']['box_clearance_mm']=100
    result=client.put(BASE+'/'+p['id'],json=p);assert result.status_code==200
    p=result.json();before=copy.deepcopy(p)
    common=set_box(client,[-500,0,0],[400,300,250])
    assert preview(client,p)['errors']
    recipe=preview(client,p,simulation_defaults=True)
    assert not recipe['errors'] and len(recipe['steps'])==17 and 'approval_id' not in recipe
    assert {item['field'] for item in recipe['simulation_defaults']}=={'box_pose'}
    assert recipe['box_pose']==[-500,0,120,0,180,0]
    assert recipe['steps'][9]['target'][:3]==[-500,0,300]
    # A scoped standby action does not depend on either missing coordinate.
    scoped={**p,'range_start':p['steps'][0]['id'],'range_end':p['steps'][0]['id']}
    assert preview(client,scoped,simulation_defaults=True)['simulation_defaults']==[]
    assert client.get(BASE+'/'+p['id']).json()==before
    assert client.get('/api/robot/parcel-box').json()==common and not calls
    # Temporary defaults cannot enter the actual execution approval schema.
    response=client.post(BASE+'/'+p['id']+'/execution-preview',json=dict(revision=p['revision'],simulation_defaults=True))
    assert response.status_code==422
    response=client.post(BASE+'/'+p['id']+'/execution-preview',json=dict(revision=p['revision']))
    assert response.status_code==409 and not client.app.state.robot.picks.approvals and not calls


def test_voice_text_and_hardware_all_use_shared_box_targets(scenario):
    client,calls,*_=scenario;p=library(client)[0]
    p.update(voice_enabled=True,aliases=['로봇 박스 시험'])
    p=client.put(BASE+'/'+p['id'],json=p).json()
    common=set_box(client,[-500,0,0],[350,270,210],tcp_pose=[-500,0,120,0,180,0])
    voice=client.app.state.robot.presets.voice
    voice.target='simulation'
    _,recipe=voice.match(p['aliases'][0])
    assert recipe['box']['center_base_mm']==common['center_base_mm']
    voice.target='hardware'
    _,physical=voice.match(p['aliases'][0])
    assert physical['box']['center_base_mm']==common['center_base_mm']
    tested=client.portal.call(voice.test,p['aliases'][0])
    assert tested['simulation_only'] and tested['recipe']['box']['center_base_mm']==common['center_base_mm']
    ticket=ready(client,p)
    assert ticket['steps'][10]['target']==common['tcp_pose']
    assert not calls


def test_manual_transfer_targets_are_independent_in_simulation_and_hardware(scenario):
    client,calls,*_=scenario;p=library(client)[0]
    first=p['steps'][3];other_ids={p['steps'][i]['id']:copy.deepcopy(p['steps'][i]['target']) for i in (4,6,7)}
    first.update(source='explicit',target=[-170,0,65,0,120,0])
    p['context']['waypoint1_joints']=None
    recipe=preview(client,p,simulation_defaults=True)
    assert not recipe['errors'] and not recipe['simulation_defaults']
    for identifier,target in other_ids.items():assert next(s for s in recipe['steps'] if s['id']==identifier)['target']==target
    saved=client.put(BASE+'/'+p['id'],json=p);assert saved.status_code==200
    physical=ready(client,saved.json())
    for identifier,target in other_ids.items():assert next(s for s in physical['steps'] if s['id']==identifier)['target']==target
    assert not calls
