import json
import socket
import struct
import threading
import subprocess
import sys
from pathlib import Path
from unittest.mock import Mock

import numpy as np
import pytest

from app.camera_views import SensorFrame
from app.realsense_transport import receive_frame, send_frame,send_sensor_buffers
from app.capture import CameraPermissionError, open_camera
from tests.fakes import settings, Detector, wait_until
from app.pipeline import Pipeline


def test_frames_preserve_color_metric_depth_ir_and_calibration_without_pickle():
    frame = SensorFrame(np.arange(60,dtype=np.uint8).reshape(4,5,3), np.full((4,5),1.25,np.float32),
                        np.full((4,5),180,np.uint8), (600,600,2,2))
    sender,receiver=socket.socketpair()
    with sender,receiver:
        send_frame(sender,frame);result=receive_frame(receiver,1)
        for key in ('color','depth','infrared'):assert np.array_equal(getattr(result,key),getattr(frame,key))
        assert result.intrinsics==frame.intrinsics
        send_frame(sender,SensorFrame(frame.color,None,None,None));result=receive_frame(receiver,1)
        assert result.depth is None and result.infrared is None and result.intrinsics is None


@pytest.mark.parametrize('metadata',[{}, {'version':1,'shape':[100000,100000,3],'depth':True,'infrared':False,'intrinsics':None},
    {'version':1,'shape':[4,5,3],'depth':True,'infrared':False,'intrinsics':[0,600,2,2]}])
def test_invalid_metadata_is_rejected_before_payload_allocation(metadata):
    sender,receiver=socket.socketpair()
    with sender,receiver:
        header=json.dumps(metadata).encode();sender.sendall(struct.pack('!I',len(header))+header)
        with pytest.raises(RuntimeError,match='정보'):receive_frame(receiver,.1)


def test_capture_error_and_disconnection_are_not_treated_as_frames():
    sender,receiver=socket.socketpair()
    with sender,receiver:
        send_frame(sender,'USB 접근 실패')
        with pytest.raises(RuntimeError,match='USB 접근 실패'):receive_frame(receiver,1)
        sender.shutdown(socket.SHUT_RDWR)
        with pytest.raises(RuntimeError,match='연결을 종료'):receive_frame(receiver,1)


def test_pending_read_can_be_cancelled_without_waiting_for_authorization():
    sender,receiver=socket.socketpair();stop=threading.Event();stop.set()
    with sender,receiver:
        with pytest.raises(RuntimeError,match='취소'):receive_frame(receiver,120,stop)


def test_sdk_raw_depth_buffers_are_scaled_to_metres_once():
    class Frame:
        def __init__(self,array):self.array=array
        def get_width(self):return self.array.shape[1]
        def get_height(self):return self.array.shape[0]
        def get_data(self):return memoryview(self.array)
    color=np.full((4,5,3),20,np.uint8);raw=np.full((4,5),1250,np.uint16);raw[0,0]=0
    sender,receiver=socket.socketpair()
    with sender,receiver:
        send_sensor_buffers(sender,Frame(color),Frame(raw),None,(600,600,2,2),.001)
        result=receive_frame(receiver,1)
        assert np.array_equal(result.color,color) and result.depth.dtype==np.float32
        assert result.depth[0,0]==0 and result.depth[1,1]==pytest.approx(1.25)


@pytest.mark.skipif(sys.platform!='darwin',reason='macOS camera worker runtime')
def test_camera_runtime_runs_outside_protected_folders_without_writing_caches():
    if not Path('/opt/homebrew/include/librealsense2/rs.hpp').exists():pytest.skip('native SDK not installed')
    from app.realsense_runtime import stage_runtime
    with stage_runtime() as folder:
        root=Path(folder)
        result=subprocess.run([str(root/'capture'),'--help'],
                              capture_output=True,text=True,timeout=10)
        assert result.returncode==0,result.stderr
        assert 'Camera-only helper' in result.stdout
        assert not list(root.rglob('__pycache__'))


def test_privileged_capture_failure_never_falls_back_to_a_mono_webcam_or_reprompts(monkeypatch):
    monkeypatch.setenv('YOLO_REALSENSE_PRIVILEGED','1')
    monkeypatch.setattr('app.capture.camera_devices',lambda:[dict(index=0,id='rs',name='RealSense D455f')])
    helper=Mock(side_effect=RuntimeError('관리자 인증 취소'))
    monkeypatch.setattr('app.realsense_macos.MacUSB',helper)
    fallback=Mock(side_effect=AssertionError('Must not silently open the UVC depth interface'))
    monkeypatch.setattr('app.capture.OpenCVCamera',fallback)
    pipeline=Pipeline(settings(),detector_factory=Detector,retry_delays=(.001,))
    pipeline.start()
    try:
        wait_until(lambda: bool(pipeline.fatal_error))
        assert helper.call_count==1 and not fallback.called
        assert pipeline.status()['state']=='error'
    finally:pipeline.stop()
