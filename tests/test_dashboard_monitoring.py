import asyncio
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.camera_monitor import depth_point
from app.camera_views import SensorFrame
from app.conversation import ConversationHistory
from app.main import create_app
from app.store import DomainError
from app.voice import Voice
from tests.fakes import settings
from tests.test_api import factory
from tests.test_robot_scenario import scenario


def test_history_is_bounded_deduplicated_incremental_and_persists(tmp_path):
    path=tmp_path/'history.json';history=ConversationHistory(path)
    assert not path.exists() and history.snapshot()['messages']==[]
    for i in range(205):history.append('user',str(i),context='packing',session_id='one',key=str(i))
    history.append('user','duplicate',context='packing',key='204')
    restored=ConversationHistory(path);assert restored.cursor==205
    assert len(restored.snapshot()['messages'])==200
    assert [m['text'] for m in restored.snapshot(203)['messages']]==['203','204']
    assert restored.snapshot(1000)['reset'] and len(restored.snapshot(1000)['messages'])==200
    assert restored.epoch==history.epoch


def test_dashboard_shell_and_dependencies_are_served_without_native_camera(scenario):
    client,calls,*_=scenario
    html=client.get('/').text
    assert 'dashboard-monitor' in html and 'Depth 카메라' in html and '음성 대화 내역' in html
    for name in ('dashboard-monitor.js','dashboard-monitor.css','dashboard-depth.js','dashboard-conversation.js','packing.js','robot-arm-view.js'):
        assert client.get('/static/'+name).status_code==200
    assert not calls


def test_packing_history_records_final_reply_and_end_without_duplicates(tmp_path):
    from app.store import Store
    from app.packing import Packing
    store=Store(tmp_path)
    async def run():
        voice=Voice(Packing(store),True);voice.session='session';voice.turn=1;voice.state='listening';sent=[]
        async def send(*args,**kwargs):sent.append((args,kwargs))
        voice.send=send
        event=dict(session='session',turn=1,event='final',text='주문 내역 알려줘')
        await voice.event(event);await voice.event(event)
        messages=voice.history.snapshot()['messages'];assert [m['role'] for m in messages]==['user','assistant']
        assert messages[0]['text']==event['text'] and '123' in messages[1]['text']
        assert len(sent)==1
        voice.state='listening';voice.turn=2
        await voice.event(dict(session='session',turn=2,event='final',text='대화 종료'))
        assert voice.session is None and voice.history.snapshot()['messages'][-1]['text']=='대화를 종료했습니다.'
        await voice.event(dict(session='session',turn=3,event='final',text='재고 알려줘'))
        assert len(voice.history.snapshot()['messages'])==4
    try:asyncio.run(run())
    finally:store.close()


def test_native_history_endpoint_is_read_only_and_survives_end(tmp_path,monkeypatch):
    monkeypatch.setenv('YOLO_ROBOT_WEB_OWNER','compose')
    with TestClient(create_app(settings(),factory,tmp_path)) as client:
        voice=client.app.state.voice;voice.history.append('assistant','대화 내역',context='packing')
        before=voice.history.path.read_bytes()
        value=client.get('/api/voice/history').json();assert value['status']['state']=='disabled'
        assert value['messages'][0]['text']=='대화 내역' and not voice.session
        assert not client.get('/api/voice/history?after=1').json()['messages']
        assert client.get('/api/voice/history?after=-1').status_code==422
        assert voice.history.path.read_bytes()==before


def test_robot_voice_history_is_separate_from_text_tests_and_approval(scenario):
    client,calls,*_=scenario;voice=client.app.state.robot.presets.voice
    client.post('/api/robot/preset-voice/test',json={'text':'미등록 문장'})
    assert not client.get('/api/robot/preset-voice/history').json()['messages']
    async def run():
        voice.session='asr';voice.message='클래스 이름을 말씀하세요.'
        try:
            with pytest.raises(DomainError):await voice.hear(dict(session_id='asr',sequence=1,text='등록되지 않은 이동'))
        finally:voice.session=None
    client.portal.call(run)
    messages=client.get('/api/robot/preset-voice/history').json()['messages']
    assert any(m['role']=='user' and m['text']=='등록되지 않은 이동' for m in messages)
    assert any(m['role']=='assistant' for m in messages) and not calls


def test_depth_point_uses_exact_frame_and_rejects_invalid_measurements():
    depth=np.full((24,32),1.25,dtype=np.float32);depth[11,15]=np.nan
    frame=SensorFrame(np.zeros((24,32,3),dtype=np.uint8),depth,None,(30,30,16,12))
    import time
    packet=SimpleNamespace(sensors=frame,frame_id=42,captured_ns=time.monotonic_ns());reads=[]
    def snapshot(session,identifier):reads.append((session,identifier));return packet,None,dict(session_id=session,width=32,height=24,camera_id='depth',camera_generation=1)
    runtime=SimpleNamespace(sensor_snapshot=snapshot)
    result=depth_point(runtime,'camera',42,16,12)
    assert reads==[('camera',42)] and result['frame_id']==42
    assert result['depth_m']==1.25 and result['point_camera_mm']==[0,0,1250]
    with pytest.raises(DomainError):depth_point(runtime,'camera',42,32,12)
    depth[:]=0
    with pytest.raises(DomainError,match='유효한 깊이'):depth_point(runtime,'camera',42,16,12)
    frame.depth=None
    with pytest.raises(DomainError,match='제공하지'):depth_point(runtime,'camera',42,16,12)


def test_depth_api_rejects_old_camera_session_and_stale_frame(tmp_path,monkeypatch):
    import time
    from app.pipeline import Pipeline
    from tests.fakes import Detector,wait_until
    class Camera:
        def read(self):time.sleep(.02);return SensorFrame(np.full((24,32,3),100,np.uint8),np.full((24,32),.75,np.float32),None,(30,30,16,12))
        def close(self):pass
    class D(Detector):
        def predict(self,frame):return []
    def factory(config):return Pipeline(config,camera_factory=lambda _:Camera(),detector_factory=D)
    monkeypatch.setenv('YOLO_ROBOT_WEB_OWNER','compose')
    with TestClient(create_app(settings(),factory,tmp_path)) as client:
        wait_until(lambda:client.get('/readyz').is_success)
        packet=client.get('/api/detections/latest').json();params=dict(session_id=packet['session_id'],frame_id=packet['frame_id'],x=16,y=12)
        response=client.get('/api/camera/depth-point',params=params);assert response.status_code==200,response.text
        assert response.json()['depth_m']==.75
        assert client.get('/api/camera/depth-point',params={**params,'session_id':'old'}).status_code==412
        pipeline=client.app.state.pipeline.pipeline;pipeline.fatal_error='fixture disconnect'
        assert client.get('/api/camera/depth-point',params=params).status_code==503
