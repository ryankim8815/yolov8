"""Install versioned browser libraries; a normal startup needs no network access."""

import hashlib
import json
import os
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    directory = ROOT / ".cache/chrome-runtime"
    directory.mkdir(parents=True, exist_ok=True)
    for name, info in json.loads((ROOT / "app/chrome/vendor.json").read_text()).items():
        path = directory / name
        if (
            path.exists()
            and hashlib.sha256(path.read_bytes()).hexdigest() == info["sha256"]
        ):
            continue
        with urllib.request.urlopen(info["url"], timeout=90) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != info["sha256"]:
            raise ValueError(f"Chrome asset hash mismatch: {name}")
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as f:
            f.write(data)
        os.replace(f.name, path)
    print("Chrome runtime ready:", directory)


if __name__ == "__main__":
    main()
