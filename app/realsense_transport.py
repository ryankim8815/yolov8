"""Bounded, non-pickle frames from the camera-only macOS USB helper."""
import json
import struct
import time

from .camera_views import SensorFrame


def send_frame(connection, value):
    if isinstance(value, str):
        header = json.dumps({"error": value[:2000]}).encode()
        connection.sendall(struct.pack("!I", len(header)) + header)
        return
    arrays = [value.color, value.depth, value.infrared]
    header = json.dumps({"version": 1, "shape": list(value.color.shape),
                         "depth": value.depth is not None, "infrared": value.infrared is not None,
                         "intrinsics": value.intrinsics, "calibration": value.calibration}).encode()
    connection.sendall(struct.pack("!I", len(header)) + header)
    for array in arrays:
        if array is not None:
            connection.sendall(array.tobytes(order="C"))


def send_sensor_buffers(connection,color,depth,infrared,intrinsics,scale):
    """The elevated worker needs only the SDK and standard library, not NumPy."""
    header=json.dumps(dict(version=1,shape=[color.get_height(),color.get_width(),3],depth=bool(depth),
                           infrared=bool(infrared),intrinsics=intrinsics,depth_storage="u16",depth_scale=scale)).encode()
    connection.sendall(struct.pack("!I",len(header))+header)
    for frame in (color,depth,infrared):
        if frame:connection.sendall(bytes(frame.get_data()))


def receive_frame(connection, timeout, stop=None):
    import numpy as np
    deadline = time.monotonic() + timeout

    def exact(size):
        chunks = bytearray()
        while len(chunks) < size:
            if stop is not None and stop.is_set():
                raise RuntimeError("RealSense 연결을 취소했습니다.")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("RealSense 영상 수신 시간이 초과되었습니다.")
            connection.settimeout(min(.2, remaining))
            try:
                part = connection.recv(size - len(chunks))
            except TimeoutError:
                continue
            if not part:
                raise RuntimeError("RealSense USB 작업자가 연결을 종료했습니다.")
            chunks.extend(part)
        return chunks

    length, = struct.unpack("!I", exact(4))
    if not 0 < length <= 4096:
        raise RuntimeError("RealSense 프레임 헤더가 올바르지 않습니다.")
    try:
        header = json.loads(exact(length))
        if not isinstance(header, dict):raise ValueError()
        if "error" in header:raise RuntimeError(str(header["error"]))
        shape = header["shape"]
        if (header.get("version") != 1 or not isinstance(shape, list) or len(shape) != 3
                or any(type(n) is not int for n in shape) or shape[2] != 3
                or not 0 < shape[0] <= 1080 or not 0 < shape[1] <= 1920
                or type(header["depth"]) is not bool or type(header["infrared"]) is not bool):
            raise ValueError()
        intrinsics = header["intrinsics"]
        if intrinsics is not None and (not isinstance(intrinsics, list) or len(intrinsics) != 4
                or any(type(n) not in (int,float) or not np.isfinite(n) for n in intrinsics)
                or min(intrinsics[:2]) <= 0):raise ValueError()
        storage=header.get("depth_storage","f32")
        scale=header.get("depth_scale")
        if storage not in {"f32","u16"}:raise ValueError()
        if header["depth"] and storage=="u16" and (type(scale) not in (int,float) or not np.isfinite(scale) or not 0<scale<=1):raise ValueError()
    except (KeyError, ValueError, TypeError) as exc:
        raise RuntimeError("RealSense 프레임 정보가 올바르지 않습니다.") from exc
    height, width, _ = shape
    def array(dtype, dimensions):
        return np.frombuffer(exact(int(np.prod(dimensions)) * np.dtype(dtype).itemsize), dtype=dtype).reshape(dimensions)
    color = array(np.uint8, shape)
    depth = array(np.uint16 if storage=="u16" else np.float32, (height,width)) if header["depth"] else None
    if depth is not None and storage=="u16":depth=depth.astype(np.float32)*scale
    infrared = array(np.uint8, (height,width)) if header["infrared"] else None
    optics=header.get("calibration")
    if optics is not None:
        if (not isinstance(optics,dict) or not isinstance(optics.get("model"),str) or len(optics["model"])>64
                or not isinstance(optics.get("coeffs"),list) or len(optics["coeffs"])!=5
                or any(type(n) not in (int,float) or not np.isfinite(n) for n in optics["coeffs"])
                or optics.get("depth_coordinates")!="color_z"):
            raise RuntimeError("지원하지 않는 RealSense 광학 보정 정보입니다.")
    return SensorFrame(color, depth, infrared, tuple(intrinsics) if intrinsics else None,optics)
