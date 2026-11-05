"""The capture worker is the sole owner of VideoCapture."""


class OpenCVCamera:
    def __init__(self, settings):
        import cv2
        self._cv2 = cv2
        self._camera = cv2.VideoCapture(settings.camera_index, cv2.CAP_AVFOUNDATION)
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
