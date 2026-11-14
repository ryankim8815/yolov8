"""Prepare the browser benchmark from an existing YOLOv8 detection ONNX and COCO128."""
import argparse
import json
import shutil
from pathlib import Path

from app.config import ROOT
from scripts.common import digest, environment, write_json
from scripts import prepare_chrome

SITE = ROOT / ".cache/webgpu/site"
# Provenance of the bundled graph used for the recorded native comparison.
BUNDLED_ONNX_SHA = "0cd683ac65ca6afef0262e19d75e4b974bb8f2cab5a9b7b01c86d2489f0a8a55"
BUNDLED_SOURCE_SHA = "f59b3d833e2ff32e194b5bb8e08d211dc7c5bdf144b90d2c8412c47ccfc83b36"


def runtime():
    prepare_chrome.main()
    target = SITE / "ort"
    target.mkdir(parents=True, exist_ok=True)
    assets = json.loads((ROOT / "app/chrome/vendor.json").read_text())
    for name in assets:
        if name.startswith("ort"):
            shutil.copy2(ROOT / ".cache/chrome-runtime" / name, target / name)
    return {"name": "onnxruntime-web", "version": "1.23.2"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    from app.chrome_model import BUILTIN_ONNX, model_metadata
    parser.add_argument("--model", type=Path, default=BUILTIN_ONNX)
    parser.add_argument("--imgsz", type=int, help="Check the ONNX input size")
    parser.add_argument("--images", type=int, default=128)
    args = parser.parse_args()
    if not 1 <= args.images <= 128:
        parser.error("--images must be 1..128")
    import cv2
    import onnx
    if args.model.suffix.lower() != ".onnx" or not args.model.is_file():
        parser.error("--model must be an existing .onnx file")
    metadata = model_metadata(args.model)
    size = metadata["size"]
    if args.imgsz is not None and size != args.imgsz:
        parser.error(f"Supply an ONNX with the requested static input size (this model uses {size})")
    paths = sorted((ROOT / "data/coco128/images/train2017").glob("*.jpg"))
    if len(paths) != 128:
        raise FileNotFoundError("Run scripts.prepare --dataset-only to obtain COCO128 first")
    SITE.mkdir(parents=True, exist_ok=True)
    onnx.checker.check_model(str(args.model))
    destination_model = SITE / "yolov8n.onnx"
    if args.model.resolve() != destination_model.resolve():
        shutil.copy2(args.model, destination_model)
    model_sha = digest(destination_model)
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
    manifest = dict(schema_version=1, model="/yolov8n.onnx",
                    source_sha256=BUNDLED_SOURCE_SHA if model_sha == BUNDLED_ONNX_SHA else None,
                    model_sha256=model_sha, model_bytes=destination_model.stat().st_size,
                    settings=dict(imgsz=size, confidence=.25, iou=.45, max_det=100, batch=1, rect=False),
                    names={c["id"]: c["name"] for c in metadata["classes"]}, images=images, runtime=runtime(),
                    environment=environment())
    write_json(SITE / "manifest.json", manifest)
    print(f"Prepared {len(images)} images at {SITE}")


if __name__ == "__main__":
    main()
