"""Only standby, object and box phases calculate targets; transfer rows are independent."""
import copy

from app.robot_preset_config import PresetLibrary
from app.store import atomic_json
from tests.test_robot_scenario import scenario
from tests.test_robot_presets import BASE,library
from tests.test_module_library import modules,update,box_update

EXPECTED=['standby']*2+['object']*5+[None]*2+['box']*4+[None]*2+['standby']*2
MANUAL=(7,8,13,14)


def compile(client,p,**flags):
    response=client.post(BASE+'/'+p['id']+'/preview',json=dict(preset=p,**flags))
    assert response.status_code==200,response.text
    return response.json()


def test_exact_17_stage_policy_and_all_automatic_values(scenario):
    client,calls,*_=scenario;p=library(client)[0]
    p['context']['standby_joints']=[5,0,90,0,90,0];p['context']['standby_opening_mm']=75
    p['context']['virtual']['floor'].update(center_base_mm=[-430,10,25],size_mm=[30,50,40])
    p['box_pose']=[480,20,130,0,180,0]
    standby=modules(client)[0];standby['settings'].update(joints=[5,0,90,0,90,0],opening_mm=75);update(client,standby)
    box_update(client,tcp_pose=p['box_pose'],clearance_mm=100)
    # Even a stale explicit width from an old UI must restore standby at stage 17.
    p['steps'][-1].update(opening_source='explicit',opening_mm=44,contact=True)
    manual={s['id']:copy.deepcopy(s['target']) for s in p['steps'] if s['kind'] in {'movej','movel','movec'} and s['source']=='explicit'}
    recipe=compile(client,p);assert not recipe['errors'];steps=recipe['steps']
    assert [s['calculation_source'] for s in steps]==EXPECTED
    assert [i+1 for i,s in enumerate(steps) if not s['computed']]==[8,9,14,15]
    assert steps[0]['target']==steps[15]['target']==[5,0,90,0,90,0]
    assert steps[1]['opening_mm']==steps[16]['opening_mm']==75
    assert not steps[16]['contact']
    assert steps[2]['target']==steps[6]['target']==recipe['approach']
    assert steps[3]['opening_mm']==steps[11]['opening_mm']==recipe['opening_mm']==40
    assert steps[4]['target']==recipe['pose']==[-430,10,25,0,180,0]
    assert steps[5]['contact']
    assert steps[9]['target']==steps[12]['target']==[480,20,230,0,180,0]
    assert steps[10]['target']==p['box_pose']
    for i in MANUAL:
        assert steps[i]['target']==manual[steps[i]['id']] and not steps[i]['j1_only']
    assert not calls


def test_each_manual_row_is_independent_of_every_other_row_and_automatic_setting(scenario):
    client,calls,*_=scenario;p=library(client)[0]
    values=[[-175,1,61,2,119,3],[-5,2,62,3,118,4],[5,3,63,4,117,5],[-165,4,64,5,116,6]]
    roots=(3,4,6,7)
    for i,target in zip(roots,values):p['steps'][i]['target']=target
    p['context'].update(waypoint1_joints=None,standby_joints=[10,0,90,0,90,0])
    before=compile(client,p)
    p['steps'][3]['target']=[-160,0,70,0,110,0]
    p['context']['standby_opening_mm']=70;p['context']['virtual']['floor']['size_mm']=[50,50,50]
    p['box_pose']=[470,10,120,0,180,0]
    after=compile(client,p,simulation_defaults=True)
    assert not after['errors'] and not after['simulation_defaults']
    assert after['steps'][7]['target']==p['steps'][3]['target']
    for i in (8,13,14):assert after['steps'][i]['target']==before['steps'][i]['target']
    saved=client.put(BASE+'/'+p['id'],json=p);assert saved.status_code==200
    again=client.get(BASE+'/'+p['id']).json()
    assert [again['steps'][i]['target'] for i in roots]==[p['steps'][i]['target'] for i in roots]
    assert all(not again['steps'][i]['reference_id'] for i in roots) and not calls


def test_missing_manual_values_are_never_filled_by_simulation(scenario):
    client,calls,*_=scenario;p=library(client)[0]
    p['context']['waypoint1_joints']=None;p['box_pose']=None
    box_update(client,tcp_pose=None)
    for index in (3,4,6,7):p['steps'][index]['target']=None
    recipe=compile(client,p,simulation_defaults=True)
    assert len(recipe['errors'])==4
    assert [recipe['steps'][i]['target'] for i in MANUAL]==[None]*4
    assert [v['field'] for v in recipe['simulation_defaults']]==['box_pose']
    saved=client.put(BASE+'/'+p['id'],json=p).json()
    result=client.post(BASE+'/'+p['id']+'/execution-preview',json=dict(revision=saved['revision']))
    assert result.status_code==409 and not calls


def test_schema2_backup_freezes_old_values_once_and_keeps_ids(scenario):
    client,calls,*_=scenario;robot=client.app.state.robot;lib=robot.presets.library;p=library(client)[0]
    legacy=copy.deepcopy(p);legacy['steps']=[s.model_dump() for s in lib.migrate(legacy['context'])]
    legacy['steps'][-1].update(opening_source='explicit',opening_mm=44)
    original=dict(schema_version=2,presets=[legacy]);atomic_json(lib.path,original);raw=lib.path.read_bytes()
    migrated=PresetLibrary(lib.path.parent,robot).load();new=migrated['presets'][0]
    assert migrated['schema_version']==4 and new['id']==legacy['id'] and new['revision']!=legacy['revision']
    assert [s['id'] for s in new['steps']]==[s['id'] for s in legacy['steps'][:-1]]
    assert new['steps'][-1]['kind']=='prepare' and new['steps'][-1]['prepare_hand_id']==legacy['steps'][-1]['id']
    assert [new['steps'][i]['target'] for i in (3,4,6,7)]==[[-180,0,60,0,120,0],[0,0,60,0,120,0],[0,0,60,0,120,0],[-180,0,60,0,120,0]]
    assert all(new['steps'][i]['source']=='explicit' and new['steps'][i]['reference_id'] is None for i in (3,4,6,7))
    assert new['steps'][-1]['source']=='standby'
    backups=list(lib.path.parent.glob('backups/manual-stages-v3-*/motion-presets.json'))
    assert len(backups)==1 and backups[0].read_bytes()==raw
    assert PresetLibrary(lib.path.parent,robot).load()==migrated
    assert len(list(lib.path.parent.glob('backups/manual-stages-v3-*')))==1 and not calls
