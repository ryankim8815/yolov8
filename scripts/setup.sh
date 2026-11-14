#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
backend="${1:-chrome}"
case "$backend" in chrome|cpu) ;; *) echo "Usage: bash scripts/setup.sh [chrome|cpu]" >&2; exit 2;; esac
prefix="$ROOT_DIR/.venv-$backend"
"${YOLO_PYTHON:-python3}" -m venv "$prefix"
"$prefix/bin/python" -m pip install -r "$ROOT_DIR/requirements-$backend.txt"
exec "$prefix/bin/python" "$ROOT_DIR/scripts/prepare_chrome.py"
