"""Manual RGB-D camera registration. This module never imports a robot SDK."""
import base64
import copy
import math
import threading
import time
from uuid import uuid4

import cv2
import numpy as np

from .store import DomainError

DICTIONARY=cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)


def optics(sensors):
    meta=sensors.calibration if sensors else None
    if (sensors is None or sensors.depth is None or sensors.intrinsics is None or not meta
            or meta.get("depth_coordinates")!="color_z"):
        raise DomainError("색상 광학 보정값과 정렬된 RealSense 깊이 영상이 필요합니다.")
    model=meta["model"].lower().replace(" ","_")
    coefficients=np.array(meta["coeffs"],np.float64)
    rectified_brown=model in {"modified_brown_conrady","inverse_brown_conrady"} and not np.any(coefficients)
    if model not in {"none","brown_conrady"} and not rectified_brown:
        raise DomainError("이 카메라의 렌즈 왜곡 모델은 BASE 보정을 지원하지 않습니다.")
    fx,fy,cx,cy=sensors.intrinsics
    return np.array([[fx,0,cx],[0,fy,cy],[0,0,1.]],np.float64),coefficients


def local_corners(side):
    s=side/2
    return np.array([[-s,s,0],[s,s,0],[s,-s,0],[-s,-s,0]],np.float64)


def rigid(source,target):
    a=np.asarray(source,float);b=np.asarray(target,float)
    u,_,vt=np.linalg.svd((a-a.mean(0)).T@(b-b.mean(0)))
    r=vt.T@u.T
    if np.linalg.det(r)<0:vt[-1]*=-1;r=vt.T@u.T
    t=b.mean(0)-r@a.mean(0)
    matrix=np.eye(4);matrix[:3,:3]=r;matrix[:3,3]=t
    return matrix,float(np.max(np.linalg.norm(a@r.T+t-b,axis=1)))


def transform(matrix,points):
    return np.asarray(points)@matrix[:3,:3].T+matrix[:3,3]


def rays(pixels,k,d):
    xy=cv2.undistortPoints(np.asarray(pixels,np.float64).reshape(-1,1,2),k,d).reshape(-1,2)
    return np.column_stack((xy,np.ones(len(xy))))


def detect(sensors,config):
    k,d=optics(sensors)
    parameters=cv2.aruco.DetectorParameters();parameters.cornerRefinementMethod=cv2.aruco.CORNER_REFINE_SUBPIX
    detector=cv2.aruco.ArucoDetector(DICTIONARY,parameters)
    corners,ids,_=detector.detectMarkers(sensors.color)
    matches=[] if ids is None else [c.reshape(4,2) for c,i in zip(corners,ids.ravel()) if i==config["marker_id"]]
    if len(matches)!=1:raise DomainError("등록한 마커가 정확히 한 개 보여야 합니다. 가림·반사·마커 ID를 확인하세요.")
    pixel=matches[0].astype(np.float64)
    if min(np.linalg.norm(pixel-np.roll(pixel,1,axis=0),axis=1))<40:
        raise DomainError("마커가 너무 작게 보입니다. 검은 사각형 한 변이 영상에서 40 px 이상이어야 합니다.")
    square=local_corners(config["side_mm"])
    base,error=rigid(square,config["corners_base_mm"])
    if error>1:raise DomainError("등록한 모서리가 정사각형과 1 mm 이상 다릅니다.",422)
    # Use many interior points, not invalid/foreground depth at the black border.
    grid=np.array([[x,y] for y in np.linspace(.15,.85,8) for x in np.linspace(.15,.85,8)],np.float32)
    h=cv2.getPerspectiveTransform(np.array([[0,0],[1,0],[1,1],[0,1]],np.float32),pixel.astype(np.float32))
    samples=cv2.perspectiveTransform(grid[:,None,:],h).reshape(-1,2)
    uv=np.rint(samples).astype(int);height,width=sensors.depth.shape
    good=(uv[:,0]>=0)&(uv[:,0]<width)&(uv[:,1]>=0)&(uv[:,1]<height)
    uv=uv[good];samples=samples[good]
    z=sensors.depth[uv[:,1],uv[:,0]].astype(float)*1000
    good=np.isfinite(z)&(z>100)&(z<5000)
    if good.sum()<40:raise DomainError("마커 내부의 유효 깊이가 부족합니다. 거리·각도·조명을 확인하세요.")
    measured=rays(samples[good],k,d)*z[good,None]
    result=cv2.solvePnPGeneric(square,pixel,k,d,flags=cv2.SOLVEPNP_IPPE_SQUARE)
    options=[]
    for rv,tv in zip(result[1],result[2]):
        rotation=cv2.Rodrigues(rv)[0];translation=tv.ravel()
        camera_points=square@rotation.T+translation
        if min(camera_points[:,2])<=0:continue
        projection=cv2.projectPoints(square,rv,tv,k,d)[0].reshape(4,2)
        reproj=float(np.sqrt(np.mean(np.sum((projection-pixel)**2,axis=1))))
        normal=rotation[:,2]
        depth_error=float(np.sqrt(np.mean(((measured-translation)@normal)**2)))
        cam_marker=np.eye(4);cam_marker[:3,:3]=rotation;cam_marker[:3,3]=translation
        options.append((depth_error+reproj,base@np.linalg.inv(cam_marker),reproj,depth_error))
    if not options:raise DomainError("마커의 카메라 자세를 계산할 수 없습니다.")
    _,matrix,reproj,depth_error=min(options,key=lambda p:p[0])
    if reproj>1.5 or depth_error>10:
        raise DomainError(f"보정 오차가 기준을 초과했습니다 (영상 {reproj:.2f} px / 깊이 {depth_error:.1f} mm).")
    # A small planar image can have a low reprojection error but a biased PnP tilt.
    # Refine its normal with metric depth, then intersect the observed corner rays.
    centroid=np.median(measured,axis=0)
    _,_,vt=np.linalg.svd(measured-centroid);normal=vt[-1]
    residual=np.abs((measured-centroid)@normal)
    keep=residual<=max(1.,float(np.median(residual))*3)
    if keep.sum()<40:raise DomainError("마커 깊이 평면의 유효 점이 부족합니다.")
    inliers=measured[keep];centroid=inliers.mean(0)
    _,_,vt=np.linalg.svd(inliers-centroid);normal=vt[-1]
    directions=rays(pixel,k,d);denom=directions@normal
    if np.any(np.abs(denom)<.1):raise DomainError("마커를 너무 비스듬히 보고 있습니다.")
    corner_depths=(centroid@normal)/denom
    camera_corners=directions*corner_depths[:,None]
    if min(corner_depths)<=0 or max(abs(np.linalg.norm(camera_corners-np.roll(camera_corners,1,axis=0),axis=1)-config["side_mm"]))>config["side_mm"]*.02:
        raise DomainError("깊이로 측정한 마커 크기가 등록 크기와 2% 이상 다릅니다. 출력 배율을 확인하세요.")
    matrix,fit_error=rigid(camera_corners,config["corners_base_mm"])
    projected=cv2.projectPoints(transform(np.linalg.inv(matrix),config["corners_base_mm"]),np.zeros(3),np.zeros(3),k,d)[0].reshape(4,2)
    reproj=float(np.sqrt(np.mean(np.sum((projected-pixel)**2,axis=1))))
    depth_error=float(np.sqrt(np.mean(((measured-centroid)@normal)**2)))
    if fit_error>2 or reproj>1.5 or depth_error>10:raise DomainError("깊이와 영상의 마커 좌표가 일치하지 않습니다. 출력 크기와 깊이를 확인하세요.")
    return dict(base_from_camera=matrix,pixels=pixel,reprojection_px=reproj,depth_rms_mm=depth_error,k=k,d=d)


def rotation_error(a,b):
    return math.degrees(math.acos(np.clip((np.trace(a.T@b)-1)/2,-1,1)))


class MarkerService:
    def __init__(self,runtime):
        self.runtime=runtime;self.tokens={};self.lock=threading.Lock()

    def snapshot(self,session=None,frame=None):
        runtime=self.runtime
        with runtime.lock:
            if runtime.busy or not runtime.camera_desired or runtime.pipeline is None:
                raise DomainError("카메라를 켜고 모델 전환·학습이 끝날 때까지 기다리세요.")
            return runtime.pipeline.sensor_snapshot(session,frame)

    def invalidate(self):
        self.tokens.clear()

    def solve(self,config):
        if not self.lock.acquire(blocking=False):raise DomainError("보정이 이미 진행 중입니다.")
        self.invalidate()
        try:
            values=[];binding=None;profile=None;last=None;deadline=time.monotonic()+6
            while len(values)<12 and time.monotonic()<deadline:
                packet,_,current=self.snapshot()
                if binding is not None and binding!=current:raise DomainError("보정 중 카메라 입력이 변경되었습니다.")
                binding=current
                optics(packet.sensors)
                current_profile=(tuple(packet.sensors.intrinsics),copy.deepcopy(packet.sensors.calibration))
                if profile is not None and profile!=current_profile:
                    raise DomainError("보정 중 카메라 광학 설정이 변경되었습니다. 다시 캘리브레이션하세요.",412)
                profile=current_profile
                if packet.frame_id==last:time.sleep(.03);continue
                last=packet.frame_id
                value=detect(packet.sensors,config);values.append(value)
                time.sleep(.05)
            if len(values)<12:raise DomainError("서로 다른 RGB-D 영상 12개를 수집하지 못했습니다.")
            matrices=[v["base_from_camera"] for v in values]
            translations=np.array([m[:3,3] for m in matrices]);median=np.median(translations,axis=0)
            jitter=float(max(np.linalg.norm(translations-median,axis=1)))
            rotation=max(rotation_error(matrices[0][:3,:3],m[:3,:3]) for m in matrices)
            if jitter>5 or rotation>1:
                raise DomainError(f"카메라·마커가 흔들렸습니다 (위치 {jitter:.1f} mm / 회전 {rotation:.2f}°). 고정한 뒤 다시 보정하세요.")
            u,_,vt=np.linalg.svd(sum(m[:3,:3] for m in matrices));rot=u@vt
            if np.linalg.det(rot)<0:u[:,-1]*=-1;rot=u@vt
            matrix=np.eye(4);matrix[:3,:3]=rot;matrix[:3,3]=translations.mean(0)
            token=uuid4().hex
            result=dict(token=token,camera=binding,base_from_camera=matrix.tolist(),camera_from_base=np.linalg.inv(matrix).tolist(),
                        intrinsics=values[-1]["k"].tolist(),distortion=values[-1]["d"].tolist(),
                        quality=dict(frames=len(values),reprojection_px=max(v["reprojection_px"] for v in values),
                                     depth_rms_mm=max(v["depth_rms_mm"] for v in values),translation_jitter_mm=jitter,rotation_jitter_deg=rotation))
            self.tokens[token]=dict(result=result,config=copy.deepcopy(config),optics=copy.deepcopy(profile[1]))
            return result
        finally:self.lock.release()

    def checked(self,token,session=None,frame=None):
        entry=self.tokens.get(token)
        if entry is None:raise DomainError("카메라 보정이 만료되었습니다. 다시 캘리브레이션하세요.",412)
        packet,result,binding=self.snapshot(session,frame)
        expected_k=np.array(entry["result"]["intrinsics"])
        try:actual_k,_=optics(packet.sensors)
        except DomainError as exc:
            self.tokens.pop(token,None);raise DomainError(str(exc),412) from exc
        if (binding!=entry["result"]["camera"] or packet.sensors.calibration!=entry["optics"]
                or not np.allclose(actual_k,expected_k,rtol=0,atol=1e-6)):
            self.tokens.pop(token,None);raise DomainError("카메라 세션·해상도·광학 설정이 변경되었습니다. 다시 보정하세요.",412)
        try:
            observed=detect(packet.sensors,entry["config"])
            expected=np.array(entry["result"]["base_from_camera"])
            # Check registered marker projection directly: a stationary pose can still be an incorrect PnP solution.
            cam=np.linalg.inv(expected);points=transform(cam,entry["config"]["corners_base_mm"])
            pixel=cv2.projectPoints(points,np.zeros(3),np.zeros(3),observed["k"],observed["d"])[0].reshape(4,2)
            if (np.max(np.linalg.norm(pixel-observed["pixels"],axis=1))>3
                    or np.linalg.norm(expected[:3,3]-observed["base_from_camera"][:3,3])>10
                    or rotation_error(expected[:3,:3],observed["base_from_camera"][:3,:3])>2):
                raise DomainError("카메라 또는 기준 마커 위치가 바뀌었습니다. 다시 캘리브레이션하세요.",412)
        except DomainError as exc:
            self.tokens.pop(token,None)
            raise DomainError(str(exc),412) from exc
        return entry,packet,result

    def view(self,token=None):
        error=None;calibration=None
        if token:
            try:entry,packet,_=self.checked(token);calibration=entry["result"]
            except DomainError as exc:error=str(exc);packet,_,_=self.snapshot()
        else:packet,_,_=self.snapshot()
        ok,jpeg=cv2.imencode(".jpg",packet.frame,[cv2.IMWRITE_JPEG_QUALITY,80])
        if not ok:raise DomainError("보정 영상을 만들 수 없습니다.")
        return dict(image="data:image/jpeg;base64,"+base64.b64encode(jpeg).decode(),frame_id=packet.frame_id,
                    captured_at=packet.captured_at,calibration=calibration,error=error)

    def object(self,token,session,frame,index):
        entry,packet,result=self.checked(token,session,frame)
        if result is None or not 0<=index<len(result["objects"]):raise DomainError("해당 탐지 프레임이 만료되었습니다.")
        box=result["objects"][index]["xyxy"];x1,y1,x2,y2=box
        h,w=packet.sensors.depth.shape
        if not all(math.isfinite(x) for x in box) or x1<2 or y1<2 or x2>w-2 or y2>h-2 or x2-x1<5 or y2-y1<5:
            raise DomainError("객체가 영상 경계에 잘렸거나 깊이를 측정하기에 너무 작습니다.")
        cx,cy=int((x1+x2)/2),int((y1+y2)/2)
        center=packet.sensors.depth[cy-2:cy+3,cx-2:cx+3];valid=center[np.isfinite(center)&(center>.1)&(center<5)]
        if len(valid)<15 or np.ptp(np.percentile(valid,[10,90]))>.015:
            raise DomainError("객체 중심 깊이가 불안정합니다. 반사·가림·깊이 영상을 확인하세요.")
        z=float(np.median(valid))
        # Interior samples near the same surface; bbox background never expands the gripper.
        xs=np.linspace(x1+(x2-x1)*.1,x2-(x2-x1)*.1,24).astype(int)
        ys=np.linspace(y1+(y2-y1)*.1,y2-(y2-y1)*.1,24).astype(int)
        xx,yy=np.meshgrid(xs,ys);pixels=np.column_stack((xx.ravel(),yy.ravel()))
        depths=packet.sensors.depth[pixels[:,1],pixels[:,0]]
        good=np.isfinite(depths)&(np.abs(depths-z)<.015)
        if good.sum()<len(good)*.7:raise DomainError("객체 내부 깊이의 70% 이상이 같은 표면이어야 합니다.")
        k,d=optics(packet.sensors);matrix=np.array(entry["result"]["base_from_camera"])
        cloud=transform(matrix,rays(pixels[good],k,d)*depths[good,None]*1000)
        surface=transform(matrix,rays([[(x1+x2)/2,(y1+y2)/2]],k,d)*z*1000)[0]
        bounds=transform(matrix,rays([[x1,y1],[x2,y1],[x2,y2],[x1,y2]],k,d)*z*1000)
        return dict(surface_base_mm=surface.tolist(),points_base_mm=cloud.tolist(),bbox_base_mm=bounds.tolist(),depth_mm=z*1000,
                    frame_id=frame,token=token,valid_fraction=float(good.mean()))


def marker_svg(marker_id=0,side_mm=100):
    bits=cv2.aruco.generateImageMarker(DICTIONARY,marker_id,6)
    rects=''.join(f'<rect x="{x+2}" y="{y+2}" width="1" height="1"/>' for y in range(6) for x in range(6) if bits[y,x]==0)
    labels=''.join(f'<text x="{x}" y="{y}" font-size=".45" text-anchor="middle">{name}</text>' for name,(x,y) in zip('ABCD',[(1,1.5),(9,1.5),(9,8.7),(1,8.7)]))
    # Black square is exactly side_mm; the 2-cell quiet border is outside it.
    size=side_mm*10/6
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}mm" height="{size}mm" viewBox="0 0 10 10"><rect width="10" height="10" fill="white"/><g fill="black">{rects}{labels}<text x="5" y="9.6" font-size=".3" text-anchor="middle">4X4_50 ID {marker_id} / black square {side_mm} mm / print 100%</text></g></svg>'
