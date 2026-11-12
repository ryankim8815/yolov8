"""Opt-in browser fixture: synthetic RGB-D/voice only; all hardware mutations denied."""
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import patch

import numpy as np
from fastapi import Request
from fastapi.responses import JSONResponse

from app.camera_views import SensorFrame
from app.main import create_app
from app.pipeline import Pipeline
from app.robot_preset_config import MotionPreset
from app.robot_work_points import ParcelBoxInput
from app.store import atomic_json
from tests.fakes import settings,Detector


def create_qa_app():
    state=Path(os.environ['ROBOT_STATE_DIR']).resolve()
    if not str(state).startswith(('/private/tmp/','/tmp/')) or os.getenv('ROBOT_ROS_PC_IP') or os.getenv('ROBOT_ACCESS_BACKEND')!='ros':raise RuntimeError('Temporary state and hardware-disabled environment required')
    fault={'depth':True,'disconnect':False}
    class Camera:
        def read(self):
            time.sleep(.05)
            if fault['disconnect']:raise OSError('QA sensor disconnected')
            image=np.full((240,320,3),(60,95,110),np.uint8);image[70:160,70:140]=(130,80,40)
            return SensorFrame(image,np.full((240,320),.74,np.float32) if fault['depth'] else None,None,(300,300,160,120))
        def close(self):pass
    class D(Detector):
        def predict(self,frame):return [dict(class_id=0,label='테스트 상품',confidence=.96,xyxy=[70,70,140,160])]
    def factory(config):return Pipeline(config,camera_factory=lambda _:Camera(),detector_factory=D)
    # Never connect this fixture to the production rosbridge or Mac voice helper.
    with patch.dict(os.environ,{'YOLO_ROBOT_WEB_OWNER':''}):app=create_app(settings(),factory,state)
    original=app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(application):
        with patch.dict(os.environ,{'YOLO_ROBOT_WEB_OWNER':''}):
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
                voice=application.state.voice
                for role,text in [('user','주문 내역 알려줘'),('assistant','123번 주문을 확인했습니다.')]:voice.history.append(role,text,context='packing',session_id='qa',turn=1)
                yield
    app.router.lifespan_context=lifespan
    @app.middleware('http')
    async def forbid_devices(request,call_next):
        if request.method!='GET' and request.url.path.startswith('/api/') and not (request.method=='POST' and request.url.path.startswith('/api/robot/presets/') and request.url.path.endswith('/preview')):
            return JSONResponse({'detail':'격리 모드 · 실제 장치·마이크·저장 명령 차단'},403)
        return await call_next(request)
    @app.post('/__qa/state')
    async def change(request:Request):
        body=await request.json();fault.update({k:body[k] for k in fault if k in body})
        if 'text' in body:app.state.voice.history.append('user',body['text'],context='packing',session_id='qa',turn=2)
        if body.get('robot_text'):app.state.robot.presets.voice.history.append('assistant',body['robot_text'],context='robot',source='robot-guidance')
        return {'ok':True}
    return app
