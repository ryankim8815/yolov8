"""Prepare a self-hosted, camera-free YOLOv8n browser benchmark.

Use the existing MPS Python; ONNX can be installed separately with --target.
No changes to the production server, model registry or native environments.
"""
import argparse
import base64
import hashlib
import io
import json
import shutil
import tarfile
import urllib.request
from pathlib import Path

from app.config import ROOT
from scripts.common import digest, environment, write_json

ORT_VERSION = "1.23.2"
SITE = ROOT / ".cache/webgpu/site"


def runtime():
    record = SITE / "ort/package.json"
    if record.exists() and json.loads(record.read_text())["version"] == ORT_VERSION:
        return json.loads(record.read_text())
    with urllib.request.urlopen(f"https://registry.npmjs.org/onnxruntime-web/{ORT_VERSION}", timeout=60) as response:
        package = json.load(response)
    with urllib.request.urlopen(package["dist"]["tarball"], timeout=60) as response:
        blob = response.read()
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(blob).digest()).decode()
    if integrity != package["dist"]["integrity"]:
        raise ValueError("ONNX Runtime package integrity mismatch")
    target = SITE / "ort"
    target.mkdir(parents=True, exist_ok=True)
    # Copy flat dist files explicitly; never extract arbitrary archive paths.
    with tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz") as archive:
        for member in archive.getmembers():
            path = Path(member.name)
            if member.isfile() and path.parent.as_posix() == "package/dist" and path.suffix in {".js", ".mjs", ".wasm"}:
                (target / path.name).write_bytes(archive.extractfile(member).read())
    result = {"name": "onnxruntime-web", "version": ORT_VERSION, "integrity": integrity}
    write_json(record, result)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--imgsz", type=int, default=640, choices=[320, 640])
    parser.add_argument("--images", type=int, default=128)
    args = parser.parse_args()
    if not 1 <= args.images <= 128:
        parser.error("--images must be 1..128")
    import cv2
    import onnx
    from ultralytics import YOLO
    weights = ROOT / "models/yolov8n.pt"
    paths = sorted((ROOT / "data/coco128/images/train2017").glob("*.jpg"))
    if len(paths) != 128 or not weights.exists():
        raise FileNotFoundError("Run scripts.prepare to obtain YOLOv8n and COCO128 first")
    SITE.mkdir(parents=True, exist_ok=True)
    # Export a private copy so existing model artifacts cannot be overwritten.
    private_weights = SITE.parent / "yolov8n.pt"
    shutil.copy2(weights, private_weights)
    options = dict(format="onnx", imgsz=args.imgsz, batch=1, dynamic=False,
                   device="cpu", opset=17, simplify=False, nms=False)
    yolo = YOLO(str(private_weights), task="detect")
    exported = Path(yolo.export(**options))
    model = onnx.load(str(exported))
    onnx.checker.check_model(model)
    if [d.dim_value for d in model.graph.output[0].type.tensor_type.shape.dim][:2] != [1, 84]:
        raise ValueError("Expected raw YOLOv8n COCO output [1,84,N]")
    shutil.copy2(exported, SITE / "yolov8n.onnx")
    fixtures = SITE / "fixtures"
    fixtures.mkdir(exist_ok=True)
    images = []
    for path in paths[:args.images]:
        frame = cv2.imread(str(path))
        if frame is None:
            raise ValueError(f"Cannot decode {path}")
        rgba = cv2.cvtColor(frame, cv2.COLOR_BGR2RGBA)
        destination = fixtures / (path.stem + ".rgba")
        destination.write_bytes(rgba.tobytes())
        shutil.copy2(path, fixtures / path.name)
        images.append(dict(name=path.name, width=frame.shape[1], height=frame.shape[0],
                           url="/fixtures/" + destination.name, jpeg="/fixtures/" + path.name,
                           sha256=digest(destination), source_sha256=digest(path)))
    manifest = dict(schema_version=1, model="/yolov8n.onnx", source_sha256=digest(weights),
                    model_sha256=digest(SITE / "yolov8n.onnx"), model_bytes=(SITE / "yolov8n.onnx").stat().st_size,
                    settings=dict(imgsz=args.imgsz, confidence=.25, iou=.45, max_det=100, batch=1, rect=False),
                    names=yolo.names, images=images, runtime=runtime(), export_options=options,
                    environment=environment())
    write_json(SITE / "manifest.json", manifest)
    print(f"Prepared {len(images)} images at {SITE}")


if __name__ == "__main__":
    main()
