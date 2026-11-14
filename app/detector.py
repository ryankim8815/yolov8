"""Optional CPU diagnostic detector for local YOLO checkpoints."""


class Detector:
    def __init__(self, settings):
        self.settings = settings
        self.model = None
        self.names = {}
        self.metadata = {}

    def load(self):
        s = self.settings
        if s.backend == "chrome":
            raise RuntimeError("Chrome 모델은 브라우저의 ONNX Runtime Web에서 로드하세요.")
        if not s.model_path.exists():
            raise FileNotFoundError(f"모델이 없습니다: {s.model_path}. scripts/prepare.py를 먼저 실행하세요.")
        from ultralytics import YOLO
        self.model = YOLO(str(s.model_path), task="detect")
        self.names = self.model.names
        self.metadata = {"backend": "pytorch-cpu", "compute_units": "cpu"}

    def warmup(self):
        import numpy as np
        for _ in range(self.settings.warmup):
            self.predict(np.zeros((self.settings.height, self.settings.width, 3), dtype=np.uint8))

    def predict(self, frame):
        if self.model is None:
            raise RuntimeError("Detector is not loaded")
        s = self.settings
        result = self.model.predict(frame, device="cpu", imgsz=s.imgsz, rect=False,
                                    conf=s.confidence, iou=s.iou, max_det=s.max_det,
                                    verbose=False, save=False)[0]
        rows = result.boxes.data.cpu().numpy()
        return [{"class_id": int(row[5]), "label": self.names[int(row[5])],
                 "confidence": float(row[4]), "xyxy": [float(x) for x in row[:4]]} for row in rows]

    def close(self):
        self.model = None
