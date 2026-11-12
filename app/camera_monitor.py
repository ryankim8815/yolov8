"""Read a depth sample from precisely the displayed RGB-aligned sensor frame."""
import asyncio
import math
import time

from fastapi import APIRouter,Query,Request

from .store import DomainError

router=APIRouter(prefix='/api/camera')


def depth_point(runtime,session_id,frame_id,x,y):
    import numpy as np
    packet,_,binding=runtime.sensor_snapshot(session_id,frame_id)
    sensors=packet.sensors
    if sensors is None or sensors.depth is None:raise DomainError('현재 카메라는 정렬된 Depth 영상을 제공하지 않습니다.',409)
    height,width=sensors.depth.shape
    if (width,height)!=(binding['width'],binding['height']):raise DomainError('컬러와 Depth 크기가 다릅니다. 정렬된 영상을 확인하세요.',409)
    if not 0<=x<width or not 0<=y<height:raise DomainError('영상 안의 지점을 선택하세요.',422)
    samples=sensors.depth[max(0,y-2):y+3,max(0,x-2):x+3]
    valid=samples[np.isfinite(samples)&(samples>0)]
    if not valid.size:raise DomainError('선택 지점에는 유효한 깊이가 없습니다. 다른 지점을 선택하세요.',409)
    z=float(np.median(valid));point=None
    if sensors.intrinsics:
        fx,fy,cx,cy=sensors.intrinsics
        if all(math.isfinite(v) for v in (fx,fy,cx,cy)) and fx>0 and fy>0:point=[(x-cx)*z/fx*1000,(y-cy)*z/fy*1000,z*1000]
    return dict(**binding,frame_id=packet.frame_id,pixel=[x,y],depth_m=z,point_camera_mm=point,
                age_seconds=max(0,(time.monotonic_ns()-packet.captured_ns)/1e9),alignment='color',sample='5x5 median')


@router.get('/depth-point')
async def read_depth(request:Request,session_id:str=Query(min_length=1,max_length=64),frame_id:int=Query(ge=1),
                     x:int=Query(ge=0),y:int=Query(ge=0)):
    return await asyncio.to_thread(depth_point,request.app.state.pipeline,session_id,frame_id,x,y)
