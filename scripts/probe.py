import argparse
import json
import platform

import psutil

from app.capture import OpenCVCamera
from app.config import Settings
from .common import ROOT, environment, write_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--camera", action="store_true")
    args = parser.parse_args()
    result = environment()
    result["processor"] = platform.processor()
    result["memory_bytes"] = psutil.virtual_memory().total
    if args.camera:
        camera = None
        try:
            camera = OpenCVCamera(Settings())
            frame = camera.read()
            result["camera"] = {"available": True, "shape": list(frame.shape)}
        except Exception as exc:
            result["camera"] = {"available": False, "error": str(exc)}
        finally:
            if camera:
                camera.close()
    write_json(ROOT / "artifacts/device-probe.json", result)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
