#!/usr/bin/env bash
set -eo pipefail
source /doosan_ws/install/setup.bash
exec ros2 launch dsr_bringup2 dsr_bringup2_rviz.launch.py mode:=real model:=e0509 gui:=false \
    "host:=$ROBOT_IP" "port:=$ROBOT_PORT" "name:=$ROBOT_NAMESPACE"
