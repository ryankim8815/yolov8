"""Opt-in browser fixture: synthetic RGB-D/voice only; all hardware mutations denied."""
import os
import time
import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi import Request
from fastapi.responses import JSONResponse, HTMLResponse

from app.camera_views import SensorFrame
from app.main import create_app
from app.pipeline import Pipeline
from app.robot_preset_config import MotionPreset
from app.robot_work_points import ParcelBoxInput
from app.store import atomic_json
from app.pick_plane import CameraFrame
from app import robot_pick
from tests.fakes import settings,Detector


def create_qa_app():
    state=Path(os.environ['ROBOT_STATE_DIR']).resolve()
    if not str(state).startswith(('/private/tmp/','/tmp/')) or os.getenv('ROBOT_ROS_PC_IP') or os.getenv('ROBOT_ACCESS_BACKEND')!='ros':raise RuntimeError('Temporary state and hardware-disabled environment required')
    fault={'depth':True,'disconnect':False,'multiple':False}
    class Camera:
        def __init__(self,config):self.device_id=config.camera_id or 'qa-depth-camera';self.index=0 if self.device_id=='qa-depth-camera' else 1
        def read(self):
            time.sleep(.05)
            if fault['disconnect']:raise OSError('QA sensor disconnected')
            image=np.full((240,320,3),(60,95,110),np.uint8);image[70:160,70:140]=(130,80,40)
            return SensorFrame(image,np.full((240,320),.74,np.float32) if fault['depth'] and self.device_id=='qa-depth-camera' else None,None,(300,300,160,120))
        def close(self):pass
    class D(Detector):
        def predict(self,frame):return [dict(class_id=0,label='테스트 상품',confidence=.96,xyxy=[70,70,140,160])]+([dict(class_id=0,label='테스트 상품',confidence=.94,xyxy=[160,70,200,150])] if fault['multiple'] else [])
    def factory(config):return Pipeline(config,camera_factory=Camera,detector_factory=D)
    devices=[dict(index=0,id='qa-depth-camera',name='QA RGB-D 카메라'),dict(index=1,id='qa-rgb-camera',name='QA 컬러 카메라')]
    # Never connect this fixture to production hardware. Browser audio is mocked by UI tests.
    with patch.dict(os.environ,{'YOLO_ROBOT_WEB_OWNER':''}):app=create_app(settings(voice_enabled=True),factory,state)
    def catalog():
        rt=app.state.pipeline
        return dict(model_version=rt.model_id,model_name='격리 YOLO 모델',classes=[dict(id=0,name='테스트 상품'),dict(id=1,name='다른 상품')],ready=True,state='ready',camera=rt.status()['camera'])
    def camera(*args):return app.state.pipeline.pick_frame()
    original=app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(application):
        loop=asyncio.get_running_loop()
        async def bridge(action,after=0,session_id=None,client_id=None):
            voice=application.state.voice
            if action=='start':await voice.wake(context='robot',client_id=client_id)
            if action=='stop':await voice.stop(session_only=True,expected_session=session_id,expected_context='robot')
            return dict(**voice.status(),cursor=voice.robot_sequence,events=[e for e in voice.robot_events if e['sequence']>after and e['session_id']==voice.session])
        def native(action,after=0,*,session_id=None,client_id=None):return asyncio.run_coroutine_threadsafe(bridge(action,after,session_id,client_id),loop).result(8)
        with patch.dict(os.environ,{'YOLO_ROBOT_WEB_OWNER':''}),patch('app.capture.camera_devices',lambda:devices),patch('app.runtime.camera_device',lambda identifier:next(d for d in devices if d['id']==identifier)),patch('app.robot_preset_voice.native_voice',native),patch('app.robot_presets.read_yolo_catalog',catalog),patch('app.robot_pick.read_camera',camera):
            async with original(application):
                robot=application.state.robot
                robot.hand.table=dict(revision='qa-width',points=[dict(position=0,width_mm=80),dict(position=700,width_mm=0)])
                robot.hand.contact=dict(revision='qa-current',threshold_ma=30)
                atomic_json(robot.hand.path,robot.hand.table);atomic_json(robot.hand.contact_path,robot.hand.contact)
                robot.parcel_box.save(ParcelBoxInput(**{k:robot.parcel_box.value[k] for k in ('revision','size_mm','center_base_mm')},tcp_pose=[450,0,120,0,180,0],clearance_mm=200))
                robot.presets.modules.load();p=robot.presets.library.load()['presets'][0]
                for s in p['steps']:
                    if s['kind'] in {'movej','movel','movec'} and s['source']=='explicit':s['target']=[0,0,90,0,90,0]
                robot.presets.save(MotionPreset.model_validate(p))
                robot.presets.save(MotionPreset(name='모듈 파지·놓기',steps=[{'kind':'grasp'},{'kind':'place'}]),create=True)
                robot.presets.save(MotionPreset(name='좌표 입력 전'),create=True)
                robot.presets.save(MotionPreset(name='음성 대기 테스트',steps=[{'kind':'wait','seconds':.5}],voice_enabled=True,aliases=['로봇 테스트 대기']),create=True)
                for confirmation in ('screen','voice'):
                    robot.presets.save(MotionPreset(name='YOLO '+confirmation,object_source='yolo',confirmation=confirmation,steps=[{'kind':'grasp'},{'kind':'place'}]),create=True)
                for _ in range(200):
                    try:packet=application.state.pipeline.pick_frame();break
                    except Exception:await asyncio.sleep(.02)
                info=CameraFrame.from_packet(packet)
                plane=dict(camera=info.model_dump(),region='floor',revision='qa-plane',clearance_per_side_mm=5,
                           corners=[dict(pixel=point,pose=[*xyz,0,180,0]) for point,xyz in zip([[10,10],[310,10],[310,230],[10,230]],[[-520,-70,20],[-380,-70,20],[-380,70,20],[-520,70,20]])])
                robot.picks.planes={robot_pick.camera_key(info)+':floor':plane};atomic_json(robot.picks.path,robot.picks.planes)
                voice=application.state.voice
                for role,text in [('user','주문 내역 알려줘'),('assistant','123번 주문을 확인했습니다.')]:voice.history.append(role,text,context='packing',session_id='qa',turn=1)
                yield
    app.router.lifespan_context=lifespan
    @app.middleware('http')
    async def forbid_devices(request,call_next):
        path=request.url.path
        safe_voice=path in {'/api/voice/wake','/api/voice/stop'} or path.startswith('/api/robot/preset-voice/')
        safe_camera=path in {'/api/camera/select','/api/camera/start','/api/camera/stop'}
        safe_packing=path.startswith('/api/packing/')
        safe_preview=path in {'/api/robot/pick/scenario/preview','/api/robot/stop','/api/robot/pick/cancel'} or path.startswith('/api/robot/presets/') and path.endswith('/preview')
        if request.method!='GET' and path.startswith('/api/') and not (safe_voice or safe_packing or safe_camera or safe_preview):
            return JSONResponse({'detail':'격리 모드 · 실제 장치·마이크·저장 명령 차단'},403)
        return await call_next(request)
    @app.get('/__qa/file-voice')
    async def file_voice():
        return HTMLResponse('<button id="start">File-only Chrome STT test</button>',headers={'Permissions-Policy':'microphone=()'})

    @app.get('/__qa/voice-fixture')
    async def voice_fixture():
        return {'fixture':'isolated-dashboard'}

    @app.post('/__qa/state')
    async def change(request:Request):
        body=await request.json();fault.update({k:body[k] for k in fault if k in body})
        if 'text' in body:app.state.voice.history.append('user',body['text'],context='packing',session_id='qa',turn=2)
        if body.get('robot_text'):app.state.robot.presets.voice.history.append('assistant',body['robot_text'],context='robot',source='robot-guidance')
        if 'utterance' in body:
            voice=app.state.voice
            if voice.state!='listening':return JSONResponse({'detail':'가짜 마이크가 듣기 상태가 아닙니다.','state':voice.state},409)
            await voice.event(dict(event='final',session=voice.session,turn=voice.turn,text=body['utterance']))
        if body.get('expire') and app.state.robot.presets.voice.pending:app.state.robot.presets.voice.pending['deadline']=0
        return {'ok':True}
    return app
