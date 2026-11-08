"""The capture worker is the sole owner of VideoCapture."""
import json
import logging
import subprocess
from pathlib import Path


def camera_devices():
    """Enumerate the Mac server's cameras without interrupting inference."""
    try:
        result = subprocess.run(
            ["/usr/bin/osascript", "-l", "JavaScript", str(Path(__file__).with_name("camera-devices.js"))],
            capture_output=True, text=True, timeout=3, check=True)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError) as exc:
        raise RuntimeError("Mac의 카메라 목록을 불러올 수 없습니다. 다시 조회하세요.") from exc


def camera_device(device_id):
    for device in camera_devices():
        if device["id"] == device_id:
            return device
    raise LookupError("선택한 카메라가 연결되어 있지 않습니다. 카메라 목록을 새로고침하세요.")


def open_camera(settings):
    # Preserve the configured index when device discovery is unavailable.
    try:
        devices = camera_devices()
    except RuntimeError:
        devices = []
    key = "id" if settings.camera_id else "index"
    value = settings.camera_id or settings.camera_index
    selected = next((d for d in devices if d[key] == value), None)
    real_devices = [d for d in devices if "realsense" in d["name"].lower()]
    note = None
    if selected and selected in real_devices:
        from .realsense import RealSenseCamera
        if len(real_devices) == 1:
            try:
                camera = RealSenseCamera(selected["index"])
                camera.device_id = selected["id"]
                return camera
            except (OSError, RuntimeError) as exc:
                logging.getLogger(__name__).warning("RealSense sensor capture unavailable: %s", exc)
                if "No module named 'pyrealsense2'" in str(exc):
                    note = "깊이·적외선 표시에는 RealSense SDK가 필요합니다."
                else:
                    note = "깊이·적외선 스트림을 열 수 없습니다. USB 연결과 접근 권한을 확인하세요."
        else:
            note = "RealSense 장치가 여러 개여서 깊이 센서를 식별할 수 없습니다."
    camera = OpenCVCamera(settings)
    camera.device_id = selected["id"] if selected else settings.camera_id
    camera.mode_note = note
    return camera


class OpenCVCamera:
    def __init__(self, settings):
        import cv2
        self._cv2 = cv2
        # Resolve again on reconnect: plugging in another device can shift indices.
        self.index = camera_device(settings.camera_id)["index"] if settings.camera_id else settings.camera_index
        self._camera = cv2.VideoCapture(self.index, cv2.CAP_AVFOUNDATION)
        if not self._camera.isOpened():
            self._camera.release()
            raise RuntimeError("카메라를 열 수 없습니다. 인덱스와 macOS 카메라 권한을 확인하세요.")
        self._camera.set(cv2.CAP_PROP_FRAME_WIDTH, settings.width)
        self._camera.set(cv2.CAP_PROP_FRAME_HEIGHT, settings.height)
        self._camera.set(cv2.CAP_PROP_FPS, settings.camera_fps)

    def read(self):
        ok, frame = self._camera.read()
        if not ok or frame is None:
            raise RuntimeError("카메라 프레임 수신이 중단되었습니다.")
        return frame

    def close(self):
        self._camera.release()
