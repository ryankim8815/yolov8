from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import threading

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.migration import VERSION
from app.model_registry import BUILTIN
from app.store import Store,DomainError
from tests.fakes import settings,wait_until
from tests.test_runtime import factory,register,runtime


def remove(client,identifier,name,**kwargs):
    return client.request('DELETE','/api/models/'+identifier,json={'name':name},**kwargs)


def test_delete_persists_hides_from_all_clients_and_blocks_reuse(tmp_path):
    config=settings(camera_autostart=False)
    with TestClient(create_app(config,factory,tmp_path)) as client:
        rt=client.app.state.pipeline;model=register(rt,'candidate');path=rt.store.root/'candidate.pt'
        rt.registry.rename(model['id'],'삭제할 모델')
        rt.store.put('setting',{'id':'selected-coreml','model_id':model['id']})
        with client.websocket_connect('/ws/events') as channel:
            channel.receive_json()
            assert remove(client,model['id'],'삭제할 모델').json()=={'id':model['id'],'deleted':True}
            for _ in range(3):
                event=channel.receive_json()
                if all(m['id']!=model['id'] for m in event['models']):break
            assert all(m['id']!=model['id'] for m in event['models'])
        assert all(m['id']!=model['id'] for m in client.get('/api/models').json()['models'])
        assert rt.store.get('model',model['id'])['deleted_at']
        assert path.read_bytes()==b'test'
        assert not any(s['model_id']==model['id'] for s in rt.store.list('setting'))
        assert rt.store.db.execute('PRAGMA foreign_key_check').fetchall()==[]
        assert remove(client,model['id'],'삭제할 모델').status_code==404
        assert client.post('/api/models/'+model['id']+'/activate').status_code==404
        assert client.patch('/api/models/'+model['id'],json={'name':'다시 사용'}).status_code==404
        cls=rt.store.named('class','label');group=rt.store.named('group','room')
        assert client.post('/api/collections',json=dict(class_id=cls['id'],group_id=group['id'],model_id=model['id'])).status_code==404
        with pytest.raises(DomainError):rt.packing.model_classes(model['id'])
    with TestClient(create_app(config,factory,tmp_path)) as client:
        assert all(m['id']!='candidate' for m in client.get('/api/models').json()['models'])
        assert client.post('/api/models/candidate/activate').status_code==404
        assert (tmp_path/'candidate.pt').is_file()


def test_active_builtin_busy_and_cross_origin_deletes_leave_models_unchanged(tmp_path):
    with TestClient(create_app(settings(),factory,tmp_path)) as client:
        rt=client.app.state.pipeline;register(rt,'candidate')
        assert remove(client,rt.model_id,rt.store.get('model',rt.model_id)['name']).status_code==409
        assert remove(client,BUILTIN,'COCO80 · YOLOv8n').status_code==409
        for busy in ('training','switching_model'):
            rt.busy=busy
            assert remove(client,'candidate','candidate').status_code==409
            assert next(m for m in client.get('/api/models').json()['models'] if m['id']=='candidate')['delete_blocked_reason']
        rt.busy=None
        for headers in ({'Origin':'https://untrusted.example'},{'Sec-Fetch-Site':'cross-site'}):
            assert remove(client,'candidate','candidate',headers=headers).status_code==403
        assert not rt.store.get('model','candidate').get('deleted_at')


def test_collection_blocks_delete_and_renamed_confirmation_must_be_reviewed(runtime):
    rt=runtime;register(rt,'candidate')
    cls=rt.store.named('class','label');group=rt.store.named('group','room')
    collection=rt.create_collection(dict(class_id=cls['id'],group_id=group['id'],model_id=rt.model_id,interval_ms=250,confidence=.5))
    rt.start_collection(collection['id'])
    with pytest.raises(DomainError,match='사진 저장'):rt.delete_model('candidate','candidate')
    rt.stop_collection(collection['id']);rt.registry.rename('candidate','새 이름')
    with pytest.raises(DomainError,match='이름이 변경'):rt.delete_model('candidate','candidate')
    assert not rt.store.get('model','candidate').get('deleted_at')
    assert rt.delete_model('candidate','새 이름')['deleted']


def test_activation_and_delete_are_serialized(runtime):
    rt=runtime;register(rt,'candidate');barrier=threading.Barrier(2)
    def race(action):
        barrier.wait()
        try:return action()
        except DomainError as error:return error.status
    with ThreadPoolExecutor(2) as pool:
        a=pool.submit(race,lambda:rt.activate('candidate'))
        b=pool.submit(race,lambda:rt.delete_model('candidate','candidate'))
        activated,deleted=a.result(),b.result()
    if isinstance(activated,dict):
        assert deleted==409
        wait_until(lambda:rt.store.get('operation',activated['id'])['state']!='running')
        assert rt.model_id=='candidate' and not rt.store.get('model','candidate').get('deleted_at')
    else:
        assert activated==404 and deleted['deleted']
        assert rt.model_id!='candidate'


def test_deleted_model_cannot_be_used_for_additional_training(runtime):
    from tests.test_datasets import populated
    rt=runtime;populated(rt.store);dataset=rt.dataset();register(rt,'candidate')
    rt.delete_model('candidate','candidate')
    with pytest.raises(DomainError,match='삭제된 모델'):
        rt.create_job(dict(dataset_id=dataset['id'],initial_model_id='candidate',batch=4,epochs=1,patience=1))
    assert rt.store.list('job')==[] and rt.store.get('dataset',dataset['id'])==dataset


def test_v3_upgrade_backs_up_and_preserves_existing_models(tmp_path):
    with closing(Store(tmp_path)) as store:
        store.put('model',{'id':'candidate','name':'이전 모델','kind':'custom','classes':[],'formats':{}})
        original=store.get('model','candidate')
        with store.db:
            store.db.execute('ALTER TABLE models DROP COLUMN deleted_at')
            store.db.execute('ALTER TABLE training_jobs DROP COLUMN class_plan')
            store.db.execute('PRAGMA user_version=3')
    with closing(Store(tmp_path)) as store:
        assert store.get('model','candidate')==original
        assert store.db.execute('PRAGMA user_version').fetchone()[0]==VERSION
        assert store.db.execute('PRAGMA foreign_key_check').fetchall()==[]
        assert len(list((tmp_path/'backups').glob('metadata-v3-*.sqlite3')))==1
