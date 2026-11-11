import asyncio

from fastapi import APIRouter,Depends,Query,Request
from fastapi.responses import Response
from pydantic import Field

from .pick_plane import Input
from .robot_access_protocol import local_json
from .robot_camera_calibration import MarkerConfig

router=APIRouter(prefix="/api/camera/marker")

def service(request):
    runtime=request.app.state.pipeline
    if not hasattr(runtime,"marker_service"):
        from .camera_marker import MarkerService
        runtime.marker_service=MarkerService(runtime)
    return runtime.marker_service

class Token(Input):
    token: str|None=Field(default=None,pattern="^[a-f0-9]{32}$")

class ObjectRequest(Token):
    token: str=Field(pattern="^[a-f0-9]{32}$")
    session_id: str=Field(min_length=1,max_length=64)
    frame_id: int=Field(ge=1)
    object_index: int=Field(ge=0,le=999)

@router.post("/solve",dependencies=[Depends(local_json)])
async def solve(body:MarkerConfig,request:Request):return await asyncio.to_thread(service(request).solve,body.model_dump())

@router.post("/view",dependencies=[Depends(local_json)])
async def view(body:Token,request:Request):return await asyncio.to_thread(service(request).view,body.token)

@router.post("/object",dependencies=[Depends(local_json)])
async def object_point(body:ObjectRequest,request:Request):
    return await asyncio.to_thread(service(request).object,body.token,body.session_id,body.frame_id,body.object_index)

@router.get("/marker.svg")
async def marker(marker_id:int=Query(default=0,ge=0,le=49),side_mm:float=Query(default=100,ge=40,le=400)):
    from .camera_marker import marker_svg
    return Response(marker_svg(marker_id,side_mm),media_type="image/svg+xml",headers={"Content-Disposition":"attachment; filename=robot-marker.svg"})
