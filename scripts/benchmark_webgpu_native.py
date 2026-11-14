"""Native reference for the browser PoC: same fixtures, decoded before timing."""
import argparse
import platform
import time
from dataclasses import replace
from pathlib import Path

from app.config import ROOT, Settings
from app.detector import Detector
from scripts.common import digest, environment, write_json
from scripts.prepare_webgpu import SITE


def stats(samples):
    import numpy as np
    mean = float(np.mean(samples))
    return dict(mean=mean, p50=float(np.percentile(samples, 50)),
                p95=float(np.percentile(samples, 95)), fps=1000 / mean)


def main():
    import json
    import cv2
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--backend", required=True, choices=["mps", "coreml"])
    parser.add_argument("--iterations", type=int, default=256)
    parser.add_argument("--warmup", type=int, default=30)
    parser.add_argument("--repeats", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.iterations <= 0 or args.warmup < 0 or args.repeats <= 0:
        parser.error("Invalid benchmark counts")
    manifest = json.loads((SITE / "manifest.json").read_text())
    settings = manifest["settings"]
    model = ROOT / "models" / ("yolov8n.mlpackage" if args.backend == "coreml" else "yolov8n.pt")
    if digest(ROOT / "models/yolov8n.pt") != manifest["source_sha256"]:
        raise ValueError("Source weights changed after ONNX preparation")
    if args.backend == "coreml":
        coreml = json.loads((ROOT / "models/manifest.json").read_text())["coreml"]
        if coreml["source_sha256"] != manifest["source_sha256"] or coreml["sha256"] != digest(model):
            raise ValueError("Core ML model provenance mismatch; re-export it")
    # These are the exact RGBA bytes delivered to the browser, not separately decoded JPEGs.
    import numpy as np
    frames = []
    for info in manifest["images"]:
        path = SITE / info["url"].lstrip("/")
        if digest(path) != info["sha256"]:
            raise ValueError(f"Fixture hash mismatch: {path}")
        rgba = np.frombuffer(path.read_bytes(), dtype=np.uint8).reshape(info["height"], info["width"], 4)
        frames.append(cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGR))
    detector = Detector(replace(Settings(), backend=args.backend, model_path=model,
                                imgsz=settings["imgsz"], confidence=settings["confidence"],
                                iou=settings["iou"], max_det=settings["max_det"], warmup=0))
    try:
        start = time.perf_counter()
        detector.load()
        load_ms = (time.perf_counter() - start) * 1000
        rounds = []
        for round_index in range(args.repeats):
            for i in range(args.warmup):
                detector.predict(frames[i % len(frames)])
            samples = []
            for i in range(args.iterations):
                start = time.perf_counter_ns()
                detector.predict(frames[i % len(frames)])
                samples.append((time.perf_counter_ns() - start) / 1e6)
            rounds.append(dict(samples=samples, predict_ms=stats(samples)))
            print(f"{args.backend} round {round_index + 1}: {rounds[-1]['predict_ms']}", flush=True)
        predictions = {info["name"]: detector.predict(frame) for info, frame in zip(manifest["images"], frames)}
        record = dict(backend=args.backend, environment={**environment(), "machine": platform.processor()},
                      settings=settings, runtime=detector.metadata, source_sha256=manifest["source_sha256"],
                      model_sha256=digest(model), image_hashes={i["name"]: i["source_sha256"] for i in manifest["images"]},
                      iterations=args.iterations, warmup=args.warmup, repeats=args.repeats,
                      load_ms=load_ms, rounds=rounds, predict_ms=stats([s for r in rounds for s in r["samples"]]),
                      predictions=predictions,
                      note="Same decoded RGBA fixtures converted to BGR before timing. Detector.predict includes preprocessing, synchronized inference / CPU results, NMS and coordinate scaling. No JPEG decode/network/camera/render.")
        write_json(args.output or ROOT / f"artifacts/webgpu-poc/{args.backend}.json", record)
    finally:
        detector.close()


if __name__ == "__main__":
    main()
