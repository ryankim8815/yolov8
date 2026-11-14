import copy
import json
import sys
from contextlib import closing
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.datasets import build_dataset,verify_dataset,save_snapshot
from app.main import create_app
from app.migration import VERSION
from app.store import Store,DomainError,sha256,atomic_json
from app.training_classes import class_options,resolve_plan,freeze_plan
from tests.fakes import settings
from tests.test_datasets import populated,add_sample,store
from tests.test_runtime import factory


def fixtures(store):
    a,b=populated(store);base=build_dataset(store)
    path=store.root/'parent.pt';path.write_bytes(b'weights')
    classes=[{**cls,'name':'cup' if cls['uuid']==a['id'] else 'person'} for cls in base['classes']]
    parent=dict(id='parent',name='기반 모델',kind='custom',family_id='parent',version_number=1,dataset_id=base['id'],classes=classes,
                formats={'mps':dict(state='ready',path=str(path),sha256=sha256(path))})
    store.put('model',parent)
    c=store.named('class','새 상품')
    add_sample(store,c['id'],'c',10);add_sample(store,c['id'],'d',11)
    extra=build_dataset(store)
    source=next(cls for cls in classes if cls['uuid']==b['id'])
    selection=dict(retained=[dict(source_class_id=source['id'],class_uuid=b['id'])],new_class_uuids=[c['id']])
    return parent,base,extra,selection


def test_subset_alias_reuse_dedup_and_final_ids_are_frozen_without_changing_sources(store):
    parent,base,extra,selection=fixtures(store)
    before=copy.deepcopy(store.list('dataset'));classes=class_options(store,parent,extra['id'])
    assert len(classes['base_classes'])==2 and len(classes['data_classes'])==3
    assert classes['base_classes'][0]['suggested_uuid']
    plan,datasets,assigned=resolve_plan(store,parent,extra['id'],selection)
    assert plan['ready'] and sum(plan['counts'].values())==4
    assert plan['classes'][0]['source_name']=='person' and plan['classes'][0]['name']=='다른 물체'
    assert [row['id'] for row in plan['classes']]==[0,1]
    assert store.list('dataset')==before
    snapshot=freeze_plan(store,(plan,datasets,assigned));verify_dataset(snapshot)
    assert [cls['name'] for cls in snapshot['classes']]==['다른 물체','새 상품']
    assert len({item['sample_id'] for item in snapshot['items']})==4
    groups={}
    for item in snapshot['items']:
        assert groups.setdefault(item['group_id'],item['split'])==item['split']
        label=(Path(snapshot['path'])/item['label']).read_text().split()
        assert int(label[0])==next(cls['id'] for cls in snapshot['classes'] if cls['uuid']==item['class_uuid'])
    assert store.get('dataset',base['id'])==base and store.get('dataset',extra['id'])==extra
    assert store.get('model',parent['id'])['classes']==parent['classes']


@pytest.mark.parametrize('problem',['unknown_source','duplicate_source','duplicate_label','unknown_label','empty'])
def test_invalid_or_empty_selection_cannot_be_frozen(store,problem):
    parent,_,extra,selection=fixtures(store)
    if problem=='unknown_source':selection['retained'][0]['source_class_id']=999
    if problem=='duplicate_source':selection['retained']*=2
    if problem=='duplicate_label':selection['new_class_uuids'].append(selection['retained'][0]['class_uuid'])
    if problem=='unknown_label':selection['new_class_uuids']=['absent']
    if problem=='empty':selection=dict(retained=[],new_class_uuids=[])
    before=len(store.list('dataset'))
    with pytest.raises(DomainError):freeze_plan(store,resolve_plan(store,parent,extra['id'],selection))
    assert len(store.list('dataset'))==before


def test_insufficient_independent_groups_are_reported_per_class(store):
    parent,base,_,_=fixtures(store)
    c=store.named('class','한 환경 상품');sample=add_sample(store,c['id'],'one-room',77)
    extra=save_snapshot(store,[dict(id=0,uuid=c['id'],name=c['name'])],[(sample,'train')],'awaiting_validation','single environment fixture')
    selection=dict(retained=[],new_class_uuids=[c['id']])
    plan=resolve_plan(store,parent,extra['id'],selection)[0]
    assert not plan['ready'] and '한 환경 상품' in ' '.join(plan['errors'])
    assert plan['classes'][0]['available']==1 and plan['classes'][0]['groups']==1


def test_identical_photos_with_different_sample_ids_are_used_only_once(store):
    parent,_,_,selection=fixtures(store)
    identifier=selection['retained'][0]['class_uuid']
    add_sample(store,identifier,'duplicate-room',3)
    extra=build_dataset(store)
    plan,_,assigned=resolve_plan(store,parent,extra['id'],selection)
    assert plan['ready'] and sum(plan['counts'].values())==4
    assert len({(sample['sha256'],sample['class_id']) for sample,_ in assigned})==4
    assert next(row for row in plan['classes'] if row['uuid']==identifier)['available']==2


def test_preview_signature_job_persistence_and_corrupt_files_are_checked(tmp_path,monkeypatch):
    with TestClient(create_app(settings(camera_autostart=False),factory,tmp_path)) as client:
        rt=client.app.state.pipeline;parent,base,extra,selection=fixtures(rt.store);spawned=[]
        rt.train_python=Path(sys.executable);monkeypatch.setattr(rt,'_spawn',lambda *args:spawned.append(args))
        values=dict(dataset_id=extra['id'],initial_model_id=parent['id'],class_selection=selection)
        options=client.get('/api/training/class-options',params={k:v for k,v in values.items() if k!='class_selection'})
        assert options.status_code==200 and len(options.json()['base_classes'])==2
        preview=client.post('/api/training/class-preview',json=values).json();assert preview['ready']
        assert client.post('/api/training/jobs',json=values).status_code==412
        changed=copy.deepcopy(parent);next(row for row in changed['classes'] if row['id']==selection['retained'][0]['source_class_id'])['name']='changed-source';rt.store.put('model',changed)
        assert client.post('/api/training/jobs',json={**values,'class_plan_signature':preview['signature']}).status_code==412
        rt.store.put('model',parent)
        response=client.post('/api/training/jobs',json={**values,'class_plan_signature':preview['signature']})
        assert response.status_code==202,response.text
        job=response.json();assert job['dataset_id'] not in {base['id'],extra['id']}
        assert job['class_plan']['signature']==preview['signature'] and len(spawned)==1
        assert rt.store.get('job',job['id'])['class_plan']==job['class_plan']
        request=json.loads((Path(job['directory'])/'request.json').read_text());assert request['class_plan']==job['class_plan']
        assert rt.store.get('dataset',base['id'])==base
        rt.busy=rt.active_job=None
        image=Path(extra['path'])/extra['items'][0]['image'];image.write_bytes(b'corrupted')
        response=client.post('/api/training/jobs',json={**values,'class_plan_signature':preview['signature']})
        assert response.status_code==422 and len(spawned)==1


def test_v4_job_plan_upgrade_preserves_rows_and_backup(tmp_path):
    with closing(Store(tmp_path)) as db:
        db.put('model',dict(id='previous',name='이전 모델',formats={},classes=[]))
        with db.db:
            db.db.execute('ALTER TABLE training_jobs DROP COLUMN class_plan')
            db.db.execute('PRAGMA user_version=4')
    with closing(Store(tmp_path)) as db:
        assert db.get('model','previous')['name']=='이전 모델'
        assert db.db.execute('PRAGMA user_version').fetchone()[0]==VERSION
        assert len(list((tmp_path/'backups').glob('metadata-v4-*.sqlite3')))==1


def test_selected_job_publishes_a_new_version_with_plan_and_metrics(tmp_path,monkeypatch):
    with TestClient(create_app(settings(camera_autostart=False),factory,tmp_path)) as client:
        rt=client.app.state.pipeline;parent,base,extra,selection=fixtures(rt.store);active=rt.model_id
        rt.train_python=Path(sys.executable);monkeypatch.setattr(rt,'_spawn',lambda *_:None)
        preview=rt.preview_training_classes(extra['id'],parent['id'],selection)
        job=rt.create_job(dict(dataset_id=extra['id'],initial_model_id=parent['id'],class_selection=selection,class_plan_signature=preview['signature'],batch=4,epochs=1,patience=1))
        def child(python,job,mode):
            directory=Path(job['directory'])
            if mode=='train':
                weights=directory/'result.pt';weights.write_bytes(b'new weights')
                atomic_json(directory/'pt-result.json',dict(format=dict(state='ready',path=str(weights),sha256=sha256(weights),metrics=dict(per_class=[dict(class_id=0,name='다른 물체',map50_95=.5)])),training=dict(class_plan=job['class_plan'],retention=[dict(class_id=0,before_map50_95=.4,after_map50_95=.5,change_percentage_points=10)]),environment={}))
            else:atomic_json(directory/'coreml-result.json',dict(state='unavailable',error='QA export fixture'))
        monkeypatch.setattr(rt,'_run_child',child);rt._job(job,rt.train_python)
        model=rt.registry.get(job['model_id'])
        assert model['version_number']==2 and model['family_id']==parent['id'] and model['parent_model_id']==parent['id']
        assert model['training']['class_plan']==job['class_plan'] and model['training']['retention'][0]['change_percentage_points']==10
        assert [c['name'] for c in model['classes']]==['다른 물체','새 상품'] and rt.model_id==active
        assert rt.registry.get(parent['id'])['classes']==parent['classes'] and rt.store.get('dataset',base['id'])==base


def test_retention_metrics_use_explicit_source_ids_on_the_same_validation_data(monkeypatch,tmp_path):
    from scripts.training_worker import retention_comparison
    closed=[]
    class Detector:
        def __init__(self,settings):self.settings=settings
        def load(self):pass
        def predict(self,frame):return [dict(class_id=41,label='cup',xyxy=[0,0,10,10],confidence=.9),dict(class_id=0,label='person',xyxy=[0,0,10,10],confidence=.8)]
        def close(self):closed.append(True)
    def accuracy(detector,paths,label_paths,note):
        assert detector.names=={0:'컵',1:'상품'}
        assert detector.predict(None)==[dict(class_id=0,label='컵',xyxy=[0,0,10,10],confidence=.9)]
        assert paths==[tmp_path/'val.jpg'] and label_paths=={str(tmp_path/'val.jpg'):tmp_path/'val.txt'}
        return dict(per_class=[dict(class_id=0,map50_95=.3,recall_at_025_iou50=.4),dict(class_id=1,map50_95=0.,recall_at_025_iou50=0.)])
    monkeypatch.setattr('scripts.training_worker.Detector',Detector);monkeypatch.setattr('scripts.training_worker.accuracy',accuracy)
    initial=tmp_path/'source.pt';initial.write_bytes(b'source')
    job=dict(initial_weights=str(initial),initial_sha256=sha256(initial),class_plan=dict(classes=[dict(id=0,name='컵',source_class_id=41,source_name='cup'),dict(id=1,name='상품',source_class_id=None,source_name=None)]),
        dataset=dict(path=str(tmp_path),items=[dict(split='val',image='val.jpg',label='val.txt')]))
    result=retention_comparison(job,dict(per_class=[dict(class_id=0,map50_95=.5,recall_at_025_iou50=.6)]))
    assert result[0]['change_percentage_points']==pytest.approx(20) and result[0]['source_class_id']==41 and closed
    initial.write_bytes(b'changed')
    with pytest.raises(ValueError,match='기반 가중치가 변경'):retention_comparison(job,dict(per_class=[]))
