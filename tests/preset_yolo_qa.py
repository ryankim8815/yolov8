"""Opt-in browser fixture. No SDK, camera, microphone, or production state access."""
import copy
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse

from app import robot_pick,robot_presets,robot_preset_voice
from app.pick_plane import CameraFrame
from app.robot_preset_config import MotionPreset,uid
from app.robot_web import create_robot_app
from app.store import DomainError,atomic_json


def create_qa_app():
    state=Path(os.environ['ROBOT_STATE_DIR']).resolve()
    if not str(state).startswith(('/private/tmp/','/tmp/')) or os.getenv('ROBOT_ROS_PC_IP') or os.getenv('ROBOT_ACCESS_BACKEND')!='ros':
        raise RuntimeError('QA requires a temporary state directory and disabled hardware')
    frame=dict(session_id='qa-camera',camera_generation=1,camera_id='isolated-fixture',frame_id=1,model_version='qa-yolo',source_size=dict(width=320,height=240),
               objects=[dict(class_id=0,label='테스트 상품',confidence=.96,xyxy=[60,60,100,100])])
    scenario='normal';voice_session=None;sequence=0;events=[];model_version='qa-yolo'
    def camera(*args):
        if scenario=='offline':raise DomainError('격리 카메라 연결 단절',503)
        packet=copy.deepcopy(frame);packet['frame_id']+=1;packet['model_version']=model_version
        if scenario=='none':packet['objects']=[]
        elif scenario=='multiple':packet['objects'].append(dict(class_id=0,label='테스트 상품',confidence=.93,xyxy=[110,50,130,70]))
        return packet
    def catalog():return dict(model_version=model_version,model_name='격리 YOLO 모델',classes=[dict(id=0,name='테스트 상품'),dict(id=1,name='다른 상품')],camera=dict(id='isolated-fixture'),ready=True,state='ready')
    def native(action,after=0,*,session_id=None):
        nonlocal voice_session
        if action=='start':voice_session=voice_session or uid()
        if action=='stop':
            if session_id is not None and session_id!=voice_session:raise DomainError('다른 테스트 세션',409)
            voice_session=None
        return dict(session_id=voice_session,context='robot',cursor=sequence,state='listening' if voice_session else 'idle',events=[e for e in events if e['sequence']>after and e['session_id']==voice_session])
    robot_pick.read_camera=camera;robot_presets.read_yolo_catalog=catalog;robot_preset_voice.native_voice=native
    app=create_robot_app();original=app.router.lifespan_context
    @asynccontextmanager
    async def lifespan(application):
        async with original(application):
            robot=application.state.robot
            async def require_ready(*args,**kwargs):
                raise DomainError('인식 자세가 다릅니다. 격리 모드에서 자세 준비 화면을 확인하세요.')
            robot.presets.detections.require_ready=require_ready
            robot.hand.table=dict(revision='qa-width',points=[dict(position=0,width_mm=80),dict(position=700,width_mm=0)])
            robot.hand.contact=dict(revision='qa-current',threshold_ma=30)
            atomic_json(robot.hand.path,robot.hand.table);atomic_json(robot.hand.contact_path,robot.hand.contact)
            camera_info=CameraFrame.from_packet(frame)
            plane=dict(camera=camera_info.model_dump(),region='floor',revision='qa-plane',clearance_per_side_mm=5,
                corners=[dict(pixel=point,pose=[*xyz,0,180,0]) for point,xyz in zip([[10,10],[150,10],[150,150],[10,150]],[[-520,-70,20],[-380,-70,20],[-380,70,20],[-520,70,20]])])
            robot.picks.planes={robot_pick.camera_key(camera_info)+':floor':plane};atomic_json(robot.picks.path,robot.picks.planes)
            p=copy.deepcopy(robot.presets.library.load()['presets'][0]);p['context']['waypoint1_joints']=[-180,0,60,0,120,0];p['context']['box_clearance_mm']=200;p['box_pose']=[450,0,120,0,180,0]
            robot.presets.save(MotionPreset.model_validate(p))
            yield
    app.router.lifespan_context=lifespan
    @app.middleware('http')
    async def forbid_devices(request,call_next):
        path=request.url.path
        if request.method!='GET' and path.startswith('/api/robot/'):
            forbidden=('execution-preview' in path or 'recognition-preview' in path or path.endswith('/executions/approve'))
            allowed=(path.startswith('/api/robot/presets') or path.startswith('/api/robot/preset-voice') or path in {'/api/robot/stop','/api/robot/pick/cancel'})
            if forbidden or not allowed:return JSONResponse(dict(detail='격리 모드 · 실제 장치 명령 차단'),503)
        return await call_next(request)
    @app.post('/__qa/state')
    async def change(request:Request):
        nonlocal scenario,sequence,model_version
        body=await request.json()
        if 'scenario' in body:
            assert body['scenario'] in {'normal','none','multiple','offline'};scenario=body['scenario']
        if 'model_version' in body:
            assert body['model_version'] in {'qa-yolo','qa-yolo-new'};model_version=body['model_version']
        if 'text' in body:
            if not voice_session:raise DomainError('테스트 청취를 먼저 시작하세요.')
            sequence+=1;events.append(dict(session_id=voice_session,sequence=sequence,text=body['text']))
        return dict(ok=True)
    return app
