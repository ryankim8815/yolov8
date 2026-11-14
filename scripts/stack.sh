#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
action="${1:-up}"
backend="${2:-chrome}"
case "$action" in
  up|down|stop-native) ;;
  *) echo "Usage: bash scripts/stack.sh [up|down|stop-native] [chrome|mps|coreml|cpu]" >&2; exit 2;;
esac
exec bash "$ROOT_DIR/scripts/python.sh" "$backend" -m scripts.stack "$action" --backend "$backend"
