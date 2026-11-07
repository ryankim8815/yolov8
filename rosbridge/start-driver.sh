#!/usr/bin/env bash
set -eo pipefail
if [[ $# -gt 1 || ( $# -eq 1 && $1 != --force-request-access && $1 != --request-access ) ]]; then
    echo 'Usage: start-driver.sh [--request-access | --force-request-access]' >&2
    exit 2
fi
export DOOSAN_ACCESS_REQUEST="${1:---request-access}"
source /doosan_ws/install/setup.bash
exec ros2 launch dsr_bringup2 dsr_bringup2_rviz.launch.py mode:=real model:=e0509 gui:=false \
    "host:=$ROBOT_IP" "port:=$ROBOT_PORT" "name:=$ROBOT_NAMESPACE"
