import sqlite3
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from app.config import Settings
from app.kiosk import Kiosk, OrderInput
from app.main import create_app
from app.migration import VERSION, install_schema
from app.packing import Packing
from app.store import Store

HEADERS={'origin':'http://localhost:8080','sec-fetch-site':'same-origin'}

@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(Settings(camera_autostart=False),state_root=tmp_path)) as c:yield c

def order(sku='PK-001',quantity=2,request_id=None,customer_id=1):
    return dict(request_id=request_id or uuid4().hex,customer_id=customer_id,items=[dict(sku=sku,quantity=quantity)])

def test_catalog_is_ready_without_prices_and_does_not_expose_customers(client):
    assert client.get('/kiosk').status_code==200
    data=client.get('/api/kiosk/catalog').json()
    assert len(data['products'])==5 and data['products'][0]['available']==9
    assert data['products'][2]['category']=='식품'
    assert not any(k in str(data) for k in ('price','total_won','rfid','customer'))
    r=client.post('/api/kiosk/orders',headers=HEADERS,json=order('PK-003',1))
    assert r.status_code==201 and r.json()['quantity']==1

def test_order_reserves_stock_and_replay_survives_restart(client,tmp_path):
    body=order();results=[client.post('/api/kiosk/orders',headers=HEADERS,json=body) for _ in range(2)]
    assert all(r.status_code==201 for r in results) and results[0].json()==results[1].json()
    receipt=results[0].json();assert receipt['number']==125 and receipt['quantity']==2 and receipt['state']=='received'
    state=client.get('/api/packing').json();p=state['products'][0]
    assert (p['stock'],p['reserved'],p['available'])==(10,3,7)
    o=next(o for o in state['orders'] if o['number']==125)
    assert o['source']=='kiosk' and len(o['items'])==2
    with closing(Store(tmp_path)) as store:
        assert Kiosk(Packing(store)).place(OrderInput(**body))==receipt
        assert len([e for e in store.list('packing_event') if '키오스크 주문 #125' in e['message']])==1
    assert client.put('/api/packing/orders/124').json()['number']==124

def test_concurrent_buyers_cannot_oversell_across_store_connections(client,tmp_path):
    def place(i):
        with closing(Store(tmp_path)) as store:
            try:return Kiosk(Packing(store)).place(OrderInput(**order('PK-005',2)))['number']
            except Exception as exc:return str(exc)
    with ThreadPoolExecutor(2) as pool:results=list(pool.map(place,range(2)))
    assert sum(isinstance(r,int) for r in results)==1
    assert next(p for p in client.get('/api/kiosk/catalog').json()['products'] if p['sku']=='PK-005')['available']==0

def test_lost_response_retry_payload_conflict_and_name_snapshot(client):
    body=order();receipt=client.post('/api/kiosk/orders',headers=HEADERS,json=body).json()
    store=client.app.state.pipeline.store
    with store.write_transaction():store.db.execute("UPDATE products SET name='변경 이름' WHERE sku='PK-001'")
    replay=client.post('/api/kiosk/orders',headers=HEADERS,json=body)
    assert replay.status_code==201 and replay.json()==receipt
    changed=order(quantity=3,request_id=body['request_id'])
    assert client.post('/api/kiosk/orders',headers=HEADERS,json=changed).status_code==409
    assert client.get('/api/kiosk/orders/'+body['request_id']).json()['items'][0]['name']=='빼빼로'

@pytest.mark.parametrize('change',[
    dict(quantity=0),dict(quantity=True),dict(quantity=100),dict(quantity=1.5),
    dict(unit_price_won=1500),dict(sku='missing'),dict(sku='PK-004'),
])
def test_invalid_orders_never_partially_write(client,change):
    body=order();body['items'][0].update(change);before=client.get('/api/packing').json()
    assert client.post('/api/kiosk/orders',headers=HEADERS,json=body).status_code in (409,422)
    assert client.get('/api/packing').json()==before

def test_multi_product_rollback_duplicate_lines_and_csrf(client):
    body=order();body['items'].append(dict(sku='PK-004',quantity=1))
    assert client.post('/api/kiosk/orders',headers=HEADERS,json=body).status_code==409
    assert len(client.get('/api/packing').json()['orders'])==1
    body=order();body['items'].append(body['items'][0])
    assert client.post('/api/kiosk/orders',headers=HEADERS,json=body).status_code==422
    assert client.post('/api/kiosk/orders',headers={'origin':'https://other.example'},json=order()).status_code==403

def test_reservation_transitions_once_when_units_are_packed(client):
    r=client.post('/api/kiosk/orders',headers=HEADERS,json=order()).json();store=client.app.state.pipeline.store
    with store.write_transaction():store.db.execute("UPDATE orders SET state='packing' WHERE number=?",(r['number'],))
    o=client.get('/api/packing/orders/'+str(r['number'])).json()
    for item in o['items']:
        assert client.put(f"/api/packing/orders/{r['number']}/items/{item['id']}/complete").status_code==200
    p=client.get('/api/packing').json()['products'][0]
    assert (p['stock'],p['reserved'],p['available'])==(8,1,7)
    assert client.get('/api/kiosk/orders/'+r['request_id']).json()['state']=='awaiting_dispatch'

def test_v5_upgrade_preserves_existing_documents_and_backs_up(tmp_path):
    db=sqlite3.connect(tmp_path/'metadata.sqlite3');db.row_factory=sqlite3.Row;repo=install_schema(db)
    repo.write('product',dict(id='old',sku='old',name='기존 상품',unit='개',stock=5,alias='기존',bin='A'))
    repo.write('packing_order',dict(id='old-order',number=123,customer='기존 고객',paused=False,state='packing',items=[dict(id='old-item',sku='old',done=False)]))
    db.execute('PRAGMA user_version=5');db.commit();db.close()
    with closing(Store(tmp_path)) as store:
        assert store.db.execute('PRAGMA user_version').fetchone()[0]==VERSION
        assert store.get('packing_order','old-order')['items']==[dict(id='old-item',sku='old',done=False)]
        assert tuple(store.db.execute('SELECT stock,reserved,available FROM inventory').fetchone())==(5,1,4)
        assert store.db.execute('SELECT count(*) FROM kiosk_orders').fetchone()[0]==0
        assert not store.db.execute('PRAGMA foreign_key_check').fetchall()
    assert len(list((tmp_path/'backups').glob('metadata-v5-*.sqlite3')))==1


def test_registered_customer_endpoint_and_exact_duplicate_identity(client):
    duplicate=client.post('/api/packing/users',json={'name':'홍길동'}).json()
    data=client.get('/api/kiosk/customers').json()['customers']
    assert {c['id'] for c in data}=={u['id'] for u in client.get('/api/packing').json()['users']}
    assert all(set(c)=={'id','name'} for c in data)
    assert len([c for c in data if c['name']=='홍길동'])==2
    before=len(client.get('/api/packing').json()['users'])
    r=client.post('/api/kiosk/orders',headers=HEADERS,json=order(customer_id=duplicate['id']))
    assert r.status_code==201,r.text
    receipt=r.json();assert receipt['customer']==dict(id=duplicate['id'],name='홍길동',is_guest=False)
    state=client.get('/api/packing').json();stored=next(o for o in state['orders'] if o['number']==receipt['number'])
    assert stored['customer_id']==duplicate['id'] and len(state['users'])==before
    assert stored['customer_id']!=state['orders'][0]['customer_id']
    db=client.app.state.pipeline.store.db
    assert db.execute('SELECT customer_id FROM orders WHERE number=?',(receipt['number'],)).fetchone()[0]==duplicate['id']


@pytest.mark.parametrize('customer_id',[None,0,-1,True,1.5,999,9007199254740992])
def test_invalid_customer_does_not_write_or_reserve(client,customer_id):
    before=client.get('/api/packing').json()
    assert client.post('/api/kiosk/orders',headers=HEADERS,json=order(customer_id=customer_id)).status_code in (409,422)
    assert client.get('/api/packing').json()==before


def test_customer_is_required_and_guest_is_not_selectable(client):
    body=order();del body['customer_id']
    assert client.post('/api/kiosk/orders',headers=HEADERS,json=body).status_code==422
    store=client.app.state.pipeline.store
    with store.write_transaction():guest=store.db.execute("INSERT INTO customers(name,kiosk_guest) VALUES ('키오스크 방문 고객',1)").lastrowid
    assert guest not in {c['id'] for c in client.get('/api/kiosk/customers').json()['customers']}
    assert client.post('/api/kiosk/orders',headers=HEADERS,json=order(customer_id=guest)).status_code==409
    assert client.post('/api/packing/users',json={'name':'키오스크 방문 고객'}).status_code==422


def test_request_identity_is_immutable_and_customer_name_is_snapshotted(client):
    body=order(customer_id=2);r=client.post('/api/kiosk/orders',headers=HEADERS,json=body).json()
    assert r['customer']['name']=='김서연'
    changed={**body,'customer_id':1}
    assert client.post('/api/kiosk/orders',headers=HEADERS,json=changed).status_code==409
    store=client.app.state.pipeline.store
    with store.write_transaction():store.db.execute("UPDATE customers SET name='이름 변경' WHERE id=2")
    assert client.post('/api/kiosk/orders',headers=HEADERS,json=body).json()==r
    assert client.get('/api/kiosk/orders/'+r['request_id']).json()['customer']==r['customer']
    assert len(client.get('/api/packing').json()['orders'])==2


def test_removed_or_retired_selection_is_revalidated_in_transaction(client):
    store=client.app.state.pipeline.store
    assert any(c['id']==2 for c in client.get('/api/kiosk/customers').json()['customers'])
    with store.write_transaction():store.db.execute('UPDATE customers SET kiosk_guest=1 WHERE id=2')
    before=client.get('/api/packing').json()
    assert client.post('/api/kiosk/orders',headers=HEADERS,json=order(customer_id=2)).status_code==409
    assert client.get('/api/packing').json()==before


def test_v6_legacy_guest_order_is_not_reattributed_during_upgrade(tmp_path):
    import hashlib,json
    db=sqlite3.connect(tmp_path/'metadata.sqlite3');db.row_factory=sqlite3.Row;repo=install_schema(db)
    repo.write('product',dict(id='old',sku='old',name='기존 상품',unit='개',stock=5,alias='기존',bin='A'))
    repo.write('packing_order',dict(id='original',number=123,customer='홍길동',paused=False,state='packing',items=[]))
    repo.write('packing_order',dict(id='old-kiosk',number=125,customer='키오스크 방문 고객',paused=False,state='received',items=[dict(id='old-item',sku='old',done=False)]))
    sql=__import__('pathlib').Path('app/kiosk_schema.sql').read_text();db.executescript(sql)
    old_id=db.execute("SELECT id FROM orders WHERE number=125").fetchone()[0]
    guest=db.execute('SELECT customer_id FROM orders WHERE number=125').fetchone()[0]
    token='a'*32;items=[{'sku':'old','quantity':1}]
    fingerprint=hashlib.sha256(json.dumps(items,sort_keys=True).encode()).hexdigest()
    db.execute('INSERT INTO kiosk_orders VALUES (?,?,?,?)',(old_id,token,fingerprint,'2026-11-12T00:00:00+00:00'))
    db.execute("INSERT INTO kiosk_order_lines VALUES (?,1,'기존 상품','개',1,0)",(old_id,))
    db.execute('PRAGMA user_version=6');db.commit();before=db.execute('SELECT stock,reserved,available FROM inventory').fetchall();db.close()
    with closing(Store(tmp_path)) as store:
        service=Kiosk(Packing(store));receipt=service.receipt(token)
        assert receipt['customer']==dict(id=guest,name='키오스크 방문 고객',is_guest=True)
        assert guest not in {c['id'] for c in service.customers()['customers']}
        assert store.db.execute('SELECT customer_id FROM orders WHERE number=125').fetchone()[0]==guest
        assert [tuple(r) for r in store.db.execute('SELECT stock,reserved,available FROM inventory')]==[tuple(r) for r in before]
        with pytest.raises(Exception,match='다른 주문자'):
            service.place(OrderInput(request_id=token,customer_id=1,items=items))
        assert len(list((tmp_path/'backups').glob('metadata-v6-*.sqlite3')))==1
        assert not store.db.execute('PRAGMA foreign_key_check').fetchall()
