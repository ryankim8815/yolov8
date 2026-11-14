#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
backend="${1:-chrome}"
case "$backend" in chrome|cpu) ;; *) echo "Usage: bash scripts/python.sh [chrome|cpu] [Python arguments]" >&2; exit 2;; esac
if [[ $# -gt 0 ]]; then shift; fi
prefix="$ROOT_DIR/.venv-$backend"
if [[ ! -x "$prefix/bin/python" ]]; then echo "Create environment first: bash scripts/setup.sh $backend" >&2; exit 1; fi
export YOLO_BACKEND="$backend"
if [[ "$backend" == cpu ]]; then
  export YOLO_CONFIG_DIR="$ROOT_DIR/.cache/ultralytics"
  export YOLO_AUTOINSTALL=false
fi
exec "$prefix/bin/python" "$@"
