"""Reproducible offline latency and COCO128 conversion comparisons (no camera recording)."""
import argparse
import time
from dataclasses import replace
from pathlib import Path

from app.config import ROOT, Settings
from app.detector import Detector
from app.pipeline import percentile
from .common import digest, environment, write_json


def image_paths():
    paths = sorted((ROOT / "data/coco128/images/train2017").glob("*.jpg"))
    if len(paths) != 128:
        raise FileNotFoundError("Run python -m scripts.prepare to obtain all 128 COCO128 images")
    return paths


def latency(detector, paths, iterations, warmup):
    import cv2
    for i in range(warmup):
        detector.predict(cv2.imread(str(paths[i % len(paths)])))
    samples = []
    total_start = time.perf_counter()
    for i in range(iterations):
        frame = cv2.imread(str(paths[i % len(paths)]))
        start = time.perf_counter_ns()
        detector.predict(frame)  # Includes materialization of CPU detection results.
        samples.append((time.perf_counter_ns() - start) / 1e6)
        if (i + 1) % 100 == 0:
            print(f"{i + 1}/{iterations}", flush=True)
    duration = time.perf_counter() - total_start
    return {"iterations": iterations, "warmup": warmup,
            "predict_ms": {"p50": percentile(samples, .5), "p95": percentile(samples, .95),
                           "mean": sum(samples) / len(samples)},
            "offline_fps_including_image_decode": iterations / duration,
            "duration_seconds": duration,
            "note": "Offline images, not camera or browser latency. Warmup excluded."}


def accuracy(detector, paths):
    import cv2
    from pycocotools.coco import COCO
    from pycocotools.cocoeval import COCOeval
    truth = {"info": {"description": "COCO128 YOLO labels converted for export parity"},
             "images": [], "annotations": [],
             "categories": [{"id": int(k) + 1, "name": name} for k, name in detector.names.items()]}
    predictions = []
    for image_id, path in enumerate(paths, 1):
        frame = cv2.imread(str(path))
        h, w = frame.shape[:2]
        truth["images"].append({"id": image_id, "width": w, "height": h, "file_name": path.name})
        label_path = ROOT / "data/coco128/labels/train2017" / (path.stem + ".txt")
        # An absent/empty label file represents a negative image in YOLO format.
        lines = label_path.read_text().splitlines() if label_path.exists() else []
        for line in lines:
            if not line.strip():
                continue
            class_id, cx, cy, bw, bh = map(float, line.split())
            bbox = [(cx - bw / 2) * w, (cy - bh / 2) * h, bw * w, bh * h]
            truth["annotations"].append({"id": len(truth["annotations"]) + 1, "image_id": image_id,
                                         "category_id": int(class_id) + 1, "bbox": bbox,
                                         "area": bbox[2] * bbox[3], "iscrowd": 0})
        for obj in detector.predict(frame):
            x1, y1, x2, y2 = obj["xyxy"]
            predictions.append({"image_id": image_id, "category_id": obj["class_id"] + 1,
                                "bbox": [x1, y1, x2 - x1, y2 - y1], "score": obj["confidence"]})
    ground_truth = COCO()
    ground_truth.dataset = truth
    ground_truth.createIndex()
    if predictions:
        detected = ground_truth.loadRes(predictions)
    else:
        detected = COCO()
        detected.dataset = {**truth, "annotations": []}
        detected.createIndex()
    evaluation = COCOeval(ground_truth, detected, "bbox")
    evaluation.params.imgIds = list(range(1, len(paths) + 1))
    evaluation.params.maxDets = [1, 10, detector.settings.max_det]
    evaluation.evaluate()
    evaluation.accumulate()
    evaluation.summarize()
    return {"images": len(paths), "detections": len(predictions),
            "map50_95": float(evaluation.stats[0]), "map50": float(evaluation.stats[1]),
            "recall_at_max_det": float(evaluation.stats[8]),
            "note": "COCO128 train-derived sample; conversion sanity check, not held-out deployment accuracy."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", choices=["mps", "cpu", "coreml"], required=True)
    parser.add_argument("--mode", choices=["latency", "accuracy"], default="latency")
    parser.add_argument("--iterations", type=int, default=1000)
    parser.add_argument("--warmup", type=int, default=50)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.iterations <= 0 or args.warmup < 0:
        parser.error("iterations must be positive and warmup non-negative")
    model = ROOT / "models" / ("yolov8n.mlpackage" if args.backend == "coreml" else "yolov8n.pt")
    config = replace(Settings(), backend=args.backend, model_path=model, imgsz=args.imgsz,
                     confidence=.001 if args.mode == "accuracy" else .25, warmup=0)
    detector = Detector(config)
    started = time.perf_counter()
    try:
        detector.load()
        load_seconds = time.perf_counter() - started
        paths = image_paths()
        result = latency(detector, paths, args.iterations, args.warmup) if args.mode == "latency" else accuracy(detector, paths)
        record = {"mode": args.mode, "backend": args.backend, "environment": environment(),
                  "runtime": detector.metadata, "model_sha256": digest(model),
                  "dataset_sha256": digest(ROOT / "data/coco128"),
                  "settings": {"imgsz": config.imgsz, "rect": False, "confidence": config.confidence,
                               "iou": config.iou, "max_det": config.max_det, "batch": 1},
                  "load_seconds": load_seconds, "results": result}
        output = args.output or ROOT / f"artifacts/{args.backend}-{args.mode}.json"
        write_json(output, record)
        print(f"Saved: {output}")
    finally:
        detector.close()


if __name__ == "__main__":
    main()
