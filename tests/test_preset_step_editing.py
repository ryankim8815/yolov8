"""Renaming never changes motion; independent steps remain independently reorderable."""
import copy

import pytest

from tests.test_robot_scenario import scenario
from tests.test_robot_presets import BASE,library,create


def preview(client,p):
    response=client.post(f'{BASE}/{p["id"]}/preview',json=dict(preset=p))
    assert response.status_code==200,response.text
    return response.json()


def test_every_physical_stage_and_module_can_be_renamed_without_changing_motion(scenario):
    client,calls,*_=scenario;p=library(client)[0];before=preview(client,p)['steps']
    names={s['id']:f'사용자 단계 {i+1}' for i,s in enumerate(before)}
    for index,root in enumerate(p['steps']):
        root['name']=f'사용자 동작 {index+1}'
        if root['kind']=='prepare':
            root['prepare_names']=[names[s['id']] for s in before if s['group_id']==root['id']]
        elif root['kind'] in {'grasp','place'}:
            for child in root['children']:child['name']=names[child['id']]
        elif root['kind']!='checkpoint':root['name']=names[root['id']]
    response=client.put(BASE+'/'+p['id'],json=p);assert response.status_code==200,response.text
    saved=response.json();assert client.get(BASE+'/'+p['id']).json()==saved
    after=preview(client,saved)['steps'];assert [s['title'] for s in after]==list(names.values())
    assert [{k:v for k,v in s.items() if k!='title'} for s in after]==[{k:v for k,v in s.items() if k!='title'} for s in before]
    assert not calls


@pytest.mark.parametrize('kind',['movej','movel','movec','gripper','wait','checkpoint'])
def test_each_independent_kind_moves_across_whole_module_boundaries(scenario,kind):
    client,calls,*_=scenario
    step=dict(kind=kind,name='개별 단계',target=[0,0,90,0,90,0],opening_mm=50,via_pose=[400,0,300,0,180,0])
    p=create(client,[dict(kind='prepare'),step,dict(kind='wait',name='끝')])
    initial=preview(client,p)['steps'];p['steps'].insert(0,p['steps'].pop(1))
    result=client.put(BASE+'/'+p['id'],json=p);assert result.status_code==200,result.text
    saved=result.json();compiled=preview(client,saved)['steps']
    assert saved['steps'][0]['kind']==kind
    groups={root['id']:[s['id'] for s in initial if (s['group_id'] or s['id'])==root['id']] for root in p['steps']}
    assert [s['id'] for s in compiled]==[identifier for root in p['steps'] for identifier in groups[root['id']]]
    assert not calls


def test_standby_names_survive_copy_and_are_bounded(scenario):
    client,calls,*_=scenario
    p=create(client,[dict(kind='prepare',name='준비 묶음',prepare_names=['관절 준비','손 준비'])])
    duplicate=client.post(BASE+'/'+p['id']+'/copy',json=dict(revision=p['revision'])).json()
    assert [s['title'] for s in preview(client,duplicate)['steps']]==['관절 준비','손 준비']
    for names in (['하나'],['하나','둘','셋'],['가'*81,'둘']):
        bad=copy.deepcopy(p);bad['steps'][0]['prepare_names']=names
        assert client.put(BASE+'/'+p['id'],json=bad).status_code==422
    assert not calls
