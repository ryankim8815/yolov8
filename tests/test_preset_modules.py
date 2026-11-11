"""Module insertion, stable whole-module ordering, and immutable internal order."""
import copy

import pytest

from app.robot_preset_config import PresetLibrary,compile_preset
from app.store import atomic_json
from tests.test_robot_scenario import scenario
from tests.test_robot_presets import BASE,library,create,ready


def preview(client,p):
    response=client.post(BASE+'/'+p['id']+'/preview',json=dict(preset=p))
    assert response.status_code==200,response.text
    return response.json()


def test_template_has_two_standby_modules_and_preserves_all_17_steps(scenario):
    client,calls,*_=scenario;p=library(client)[0];steps=preview(client,p)['steps']
    assert [s['kind'] for s in p['steps']]==['prepare','checkpoint','grasp','movej','movej','place','movej','movej','prepare']
    assert len(steps)==17
    assert steps[-2]['group_id']==steps[-1]['group_id']==p['steps'][-1]['id']
    assert steps[-1]['id']==p['steps'][-1]['prepare_hand_id']
    assert [c['module_slot'] for c in p['steps'][2]['children']]==list(range(5))
    assert [c['module_slot'] for c in p['steps'][5]['children']]==list(range(4))
    assert not calls


@pytest.mark.parametrize('kind,count',[('prepare',2),('grasp',5),('place',4)])
def test_all_three_modules_can_be_added_copied_saved_and_compiled(scenario,kind,count):
    client,calls,*_=scenario;seed=library(client)[0]
    p=create(client,[dict(kind=kind,name='모듈')],context=seed['context'],box_pose=seed['box_pose'])
    compiled=preview(client,p);assert not compiled['errors'] and len(compiled['steps'])==count
    assert all(s['group_id']==p['steps'][0]['id'] for s in compiled['steps'])
    copied=client.post(BASE+'/'+p['id']+'/copy',json=dict(revision=p['revision'])).json()
    assert preview(client,copied)['steps']==compiled['steps']
    assert len(ready(client,p)['steps'])==count and not calls


def test_reorder_moves_module_as_one_unit_and_preserves_children_values(scenario):
    client,calls,*_=scenario;p=library(client)[0];before=preview(client,p)['steps']
    modules={root['id']:[s for s in before if (s['group_id'] or s['id'])==root['id']] for root in p['steps']}
    moved=p['steps'].pop(2);p['steps'].insert(3,moved)
    result=client.put(BASE+'/'+p['id'],json=p);assert result.status_code==200,result.text
    saved=result.json();after=preview(client,saved)['steps']
    assert [s['id'] for s in after]==[step['id'] for root in saved['steps'] for step in modules[root['id']]]
    for step in after:
        original=next(s for s in before if s['id']==step['id'])
        assert {k:v for k,v in step.items() if k!='number'}=={k:v for k,v in original.items() if k!='number'}
    assert client.get(BASE+'/'+p['id']).json()==saved and not calls


@pytest.mark.parametrize('kind,indices',[('grasp',(2,4)),('place',(1,3))])
def test_swapping_same_kind_internal_steps_is_rejected_even_without_slots(scenario,kind,indices):
    client,calls,*_=scenario;p=library(client)[0]
    group=next(s for s in p['steps'] if s['kind']==kind);a,b=indices
    group['children'][a],group['children'][b]=group['children'][b],group['children'][a]
    assert client.post(BASE+'/'+p['id']+'/preview',json=dict(preset=p)).status_code==422
    assert client.put(BASE+'/'+p['id'],json=p).status_code==422
    for child in group['children']:child.pop('module_slot')
    response=client.put(BASE+'/'+p['id'],json=p)
    assert response.status_code==422 and '세부 단계 순서' in response.json()['detail']
    assert not calls


def test_internal_children_cannot_be_promoted_or_selected_as_partial_ranges(scenario):
    client,calls,*_=scenario;p=library(client)[0];grasp=p['steps'][2]
    bad=copy.deepcopy(p);bad['steps'].extend(bad['steps'][2].pop('children'))
    assert client.put(BASE+'/'+p['id'],json=bad).status_code==422
    for module in (p['steps'][0],p['steps'][2],p['steps'][5],p['steps'][-1]):
        body={**p,'range_start':module['id'],'range_end':module['id']}
        result=preview(client,body);assert len(result['steps'])=={'prepare':2,'grasp':5,'place':4}[module['kind']]
    hand=p['steps'][-1]['prepare_hand_id'];bad={**p,'range_start':hand,'range_end':hand}
    assert client.post(BASE+'/'+p['id']+'/preview',json=dict(preset=bad)).status_code==422
    assert not calls


def test_standby_module_explicit_hand_id_must_be_unique_and_has_fixed_order(scenario):
    client,calls,*_=scenario
    bad=dict(kind='prepare',id='standby',prepare_hand_id='standby')
    assert client.post(BASE,json=dict(steps=[bad])).status_code==422
    assert client.post(BASE,json=dict(steps=[dict(kind='prepare',children=[dict(kind='gripper'),dict(kind='movej')])])).status_code==422
    p=create(client,[dict(kind='prepare',id='standby',prepare_hand_id='hand')])
    assert [s['id'] for s in preview(client,p)['steps']]==['standby','hand'] and not calls


def test_v3_migration_backs_up_and_keeps_physical_ids_speeds_and_values(scenario):
    client,calls,*_=scenario;robot=client.app.state.robot;lib=robot.presets.library;p=library(client)[0]
    legacy=copy.deepcopy(p);module=legacy['steps'].pop();motion=copy.deepcopy(module)
    motion.update(kind=module['prepare_motion'],module_id=None,prepare_hand_id=None,legacy_speed=dict(speed=3,acceleration=2))
    hand=dict(id=module['prepare_hand_id'],kind='gripper',name='대기 벌림 복원',source='standby',opening_source='idle',percent=40,acceleration=3000)
    legacy['steps'].extend([motion,hand])
    # This is a schema-3 pair; its physical stage IDs and independent speeds are known.
    original=dict(schema_version=3,presets=[legacy]);atomic_json(lib.path,original);raw=lib.path.read_bytes()
    migrated=PresetLibrary(lib.path.parent,robot).load();new=migrated['presets'][0]
    assert migrated['schema_version']==4 and new['revision']!=legacy['revision']
    assert len(new['steps'])==len(legacy['steps'])-1 and new['steps'][-1]['id']==motion['id']
    assert new['steps'][-1]['prepare_hand_id']==hand['id']
    compiled=compile_preset(new,robot.hand)['steps']
    assert [s['id'] for s in compiled[-2:]]==[motion['id'],hand['id']]
    assert [s['speed']['speed'] for s in compiled[-2:]]==[3,4]
    assert compiled[-2]['target']==legacy['context']['standby_joints']
    backups=list(lib.path.parent.glob('backups/modules-v4-*/motion-presets.json'))
    assert len(backups)==1 and backups[0].read_bytes()==raw
    assert PresetLibrary(lib.path.parent,robot).load()==migrated and not calls
