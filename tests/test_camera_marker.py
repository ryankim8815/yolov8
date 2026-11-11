"""Metric synthetic RGB-D observations, not real hardware calibration evidence."""
import copy
import threading
import time
from types import SimpleNamespace

import cv2
import numpy as np
import pytest

from app.camera_marker import DICTIONARY,MarkerService,detect,local_corners,marker_svg,rays,rigid,transform
from app.camera_views import SensorFrame
from app.pipeline import FramePacket,Pipeline
from app.robot_camera_calibration import MarkerConfig
from app.store import DomainError
from tests.fakes import settings


def scene(offset=(20,-15,700),rotation=(3.0,.15,.1),distortion=(0.,0.,0.,0.,0.)):
    k=np.array([[600,0,320],[0,602,240],[0,0,1.]],float);dist=np.array(distortion,float)
    rv=np.array(rotation);r=cv2.Rodrigues(rv)[0];t=np.array(offset,float)
    local=local_corners(100)
    pixel=cv2.projectPoints(local,rv,t,k,dist)[0].reshape(4,2)
    pattern=cv2.aruco.generateImageMarker(DICTIONARY,0,240)
    homography=cv2.getPerspectiveTransform(np.array([[0,0],[239,0],[239,239],[0,239]],np.float32),pixel.astype(np.float32))
    image=cv2.warpPerspective(pattern,homography,(640,480),borderValue=255)
    color=cv2.cvtColor(image,cv2.COLOR_GRAY2BGR)
    yy,xx=np.indices((480,640));directions=rays(np.column_stack((xx.ravel(),yy.ravel())),k,dist)
    normal=r[:,2];z=(t@normal)/(directions@normal)
    depth=(z.reshape(480,640)/1000).astype(np.float32)
    base=np.eye(4);base[:3,:3]=cv2.Rodrigues(np.array([.2,-.4,.1]))[0];base[:3,3]=[-300,100,500]
    config=dict(marker_id=0,side_mm=100.,corners_base_mm=transform(base,local@r.T+t).tolist())
    sensor=SensorFrame(color,depth,None,(600,602,320,240),dict(model="Brown Conrady",coeffs=dist.tolist(),depth_coordinates="color_z",serial="fixture"))
    return sensor,config,base


def test_marker_recovers_base_camera_with_depth_and_reprojects_registered_corners():
    sensor,config,expected=scene()
    MarkerConfig.model_validate(config)
    value=detect(sensor,config)
    assert value['reprojection_px']<1 and value['depth_rms_mm']<5
    actual=value['base_from_camera']
    assert np.linalg.norm(actual[:3,3]-expected[:3,3])<5
    assert np.max(np.abs(transform(actual,[[0,0,700]])-transform(expected,[[0,0,700]])))<2


@pytest.mark.parametrize('failure',['missing','duplicate','depth','scale','optics'])
def test_bad_marker_or_depth_never_produces_a_transform(failure):
    sensor,config,_=scene()
    if failure=='missing':sensor.color[:]=255
    elif failure=='duplicate':
        sensor.color[25:125,20:120]=cv2.cvtColor(cv2.aruco.generateImageMarker(DICTIONARY,0,100),cv2.COLOR_GRAY2BGR)
    elif failure=='depth':sensor.depth[:]=0
    elif failure=='scale':config['side_mm']=150
    else:sensor.calibration['model']='Inverse Brown Conrady';sensor.calibration['coeffs'][0]=.2
    with pytest.raises(DomainError):detect(sensor,config)


class FakePipeline:
    def __init__(self,sensor):self.sensor=sensor;self.frame=0;self.generation=1;self.objects=[]
    def sensor_snapshot(self,session=None,frame=None):
        self.frame+=1
        packet=FramePacket(frame or self.frame,self.generation,time.monotonic_ns(),'2026-11-11T01:00:00Z',self.sensor.color,self.sensor)
        return packet,dict(objects=self.objects),dict(camera_id='fixture',session_id='session',camera_generation=self.generation,width=640,height=480)


def service(sensor):
    pipeline=FakePipeline(sensor)
    runtime=SimpleNamespace(lock=threading.RLock(),busy=False,camera_desired=True,pipeline=pipeline)
    return MarkerService(runtime),pipeline


def test_manual_solve_revision_depth_object_and_restart_fail_closed(monkeypatch):
    sensor,config,base=scene();value,pipeline=service(sensor)
    monkeypatch.setattr('app.camera_marker.time.sleep',lambda _:None)
    result=value.solve(config);assert result['quality']['frames']==12
    assert result['token'] in value.tokens
    pipeline.objects=[dict(xyxy=[400,290,430,320],class_id=0)]
    point=value.object(result['token'],'session',20,0)
    assert point['frame_id']==20 and point['valid_fraction']>.9
    assert len(point['points_base_mm'])<=576
    assert len(point['bbox_base_mm'])==4
    restarted,_=service(sensor)
    with pytest.raises(DomainError,match='만료'):restarted.checked(result['token'])
    pipeline.generation+=1
    with pytest.raises(DomainError,match='변경'):value.checked(result['token'])
    assert result['token'] not in value.tokens


def test_camera_motion_invalidates_token_instead_of_auto_recalibrating(monkeypatch):
    sensor,config,_=scene();value,pipeline=service(sensor)
    monkeypatch.setattr('app.camera_marker.time.sleep',lambda _:None)
    result=value.solve(config)
    moved,_,_=scene(offset=(60,-15,700));pipeline.sensor=moved
    with pytest.raises(DomainError,match='바뀌었'):value.checked(result['token'])
    assert not value.tokens


def test_unstable_camera_during_capture_has_no_saved_transform(monkeypatch):
    sensor,config,_=scene();value,pipeline=service(sensor)
    monkeypatch.setattr('app.camera_marker.time.sleep',lambda _:None)
    original=value.snapshot
    def snapshot(*args):
        packet,result,binding=original(*args)
        if pipeline.frame==6:pipeline.sensor=scene(offset=(50,-15,700))[0]
        return packet,result,binding
    monkeypatch.setattr(value,'snapshot',snapshot)
    with pytest.raises(DomainError,match='흔들'):value.solve(config)
    assert not value.tokens


def test_depth_discontinuity_and_cropped_boxes_are_not_valid_grasp_targets(monkeypatch):
    sensor,config,_=scene();value,pipeline=service(sensor)
    monkeypatch.setattr('app.camera_marker.time.sleep',lambda _:None)
    token=value.solve(config)['token']
    pipeline.objects=[dict(xyxy=[400,290,430,320],class_id=0)]
    sensor.depth[303:308,413:418]=0
    with pytest.raises(DomainError,match='중심 깊이'):value.object(token,'session',20,0)
    pipeline.objects[0]['xyxy']=[0,10,30,40]
    with pytest.raises(DomainError,match='경계'):value.object(token,'session',20,0)


def test_marker_svg_physical_square_and_canonical_corner_letters():
    svg=marker_svg(3,120)
    assert 'width="200.0mm"' in svg and 'black square 120 mm' in svg
    import xml.etree.ElementTree as ET
    tree=ET.fromstring(svg)
    assert [n.text for n in tree.iter('{http://www.w3.org/2000/svg}text')][:4]==list('ABCD')


def test_metric_depth_noise_still_recovers_nearby_base_points():
    sensor,config,expected=scene()
    sensor.depth+=np.random.default_rng(42).normal(0,.001,sensor.depth.shape).astype(np.float32)
    actual=detect(sensor,config)
    assert actual['depth_rms_mm']<3
    assert np.linalg.norm(transform(actual['base_from_camera'],[[0,0,700]])-transform(expected,[[0,0,700]]))<3


def test_raw_depth_cannot_be_combined_with_a_different_frame(tmp_path):
    p=Pipeline(settings());sensor,_,_=scene();p.camera_online=True;p.generation=1;p.camera_id='fixture'
    packet=FramePacket(2,1,time.monotonic_ns(),'now',sensor.color,sensor)
    p.sensor_history.append((packet,dict(frame_id=2)));p.capture_packet=packet
    assert p.sensor_snapshot(p.session_id,2)[0] is packet
    with pytest.raises(DomainError):p.sensor_snapshot(p.session_id,3)
    with pytest.raises(DomainError,match='세션'):p.sensor_snapshot('old',2)
    p.generation=2
    with pytest.raises(DomainError,match='만료'):p.sensor_snapshot(p.session_id,2)


def test_optical_profile_change_during_collection_rejects_all_frames(monkeypatch):
    sensor,config,_=scene();value,pipeline=service(sensor)
    monkeypatch.setattr('app.camera_marker.time.sleep',lambda _:None)
    original=value.snapshot
    def snapshot(*args):
        if pipeline.frame==5:pipeline.sensor.intrinsics=(600.1,602,320,240)
        return original(*args)
    monkeypatch.setattr(value,'snapshot',snapshot)
    with pytest.raises(DomainError,match='광학'):value.solve(config)
    assert not value.tokens


def test_optical_baseline_is_an_immutable_copy(monkeypatch):
    sensor,config,_=scene();value,_=service(sensor)
    monkeypatch.setattr('app.camera_marker.time.sleep',lambda _:None)
    token=value.solve(config)['token']
    sensor.calibration['coeffs'][0]=.00001
    with pytest.raises(DomainError,match='광학'):value.checked(token)
    assert token not in value.tokens


@pytest.mark.parametrize('offset,rotation',[
    ((-130,80,600),(3.05,-.1,.1)),((200,-100,850),(2.75,.25,.2)),((20,20,1000),(2.9,.15,-.1))])
def test_metric_calibration_with_lens_distortion_and_different_viewpoints(offset,rotation):
    sensor,config,base=scene(offset,rotation,distortion=(.05,-.02,.001,-.001,.005))
    result=detect(sensor,config)
    assert result['reprojection_px']<=1.5 and result['depth_rms_mm']<=10
    assert np.linalg.norm(transform(result['base_from_camera'],[offset])-transform(base,[offset]))<3
