"""Receive E0509 telemetry through rosbridge on the external ROS 2 controller."""
import asyncio
import ipaddress
import json
import math
import os
import re
import time
from collections import deque
from contextlib import suppress
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from .robot_poses import PoseInput, PoseRevision, PoseTests
from .store import DomainError


@dataclass(frozen=True)
class RobotSettings:
    ip: str = "110.120.1.56"
    port: int = 12345
    namespace: str = "dsr01"
    ros_pc_ip: str = ""
    rosbridge_port: int = 9090
    stale_seconds: float = 3.0

    def __post_init__(self):
        ipaddress.ip_address(self.ip)
        if not 1 <= self.port <= 65535:
            raise ValueError("ROBOT_PORT must be between 1 and 65535")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(/[A-Za-z_][A-Za-z0-9_]*)*", self.namespace):
            raise ValueError("ROBOT_NAMESPACE must be a ROS namespace such as dsr01")
        if not math.isfinite(self.stale_seconds) or self.stale_seconds <= 0:
            raise ValueError("ROBOT_STALE_SECONDS must be finite and positive")
        if not 1 <= self.rosbridge_port <= 65535:
            raise ValueError("ROBOT_ROSBRIDGE_PORT must be between 1 and 65535")
        if self.ros_pc_ip:
            try:
                address = ipaddress.ip_address(self.ros_pc_ip)
            except ValueError:
                raise ValueError("ROBOT_ROS_PC_IP must be an IP address") from None
            scope = getattr(address, "scope_id", None)
            if scope and not re.fullmatch(r"[A-Za-z0-9_.-]+", scope):
                raise ValueError("ROBOT_ROS_PC_IP has an invalid interface scope")

    @classmethod
    def from_env(cls):
        return cls(ip=os.getenv("ROBOT_IP", "110.120.1.56"),
                   port=int(os.getenv("ROBOT_PORT", "12345")),
                   namespace=os.getenv("ROBOT_NAMESPACE", "dsr01").strip("/"),
                   ros_pc_ip=os.getenv("ROBOT_ROS_PC_IP", "").strip(),
                   rosbridge_port=int(os.getenv("ROBOT_ROSBRIDGE_PORT", "9090")),
                   stale_seconds=float(os.getenv("ROBOT_STALE_SECONDS", "3")))


class RobotMonitor:
    def __init__(self, settings, state_dir=None):
        self.settings = settings
        prefix = "/" + settings.namespace
        self.topics = [
            {"name": prefix + "/joint_states", "type": "sensor_msgs/msg/JointState", "kind": "joints"},
            {"name": prefix + "/error", "type": "dsr_msgs2/msg/RobotError", "kind": "event"},
            {"name": prefix + "/robot_disconnection", "type": "dsr_msgs2/msg/RobotDisconnection", "kind": "event"},
            {"name": prefix + "/monitor/joint_states", "type": "sensor_msgs/msg/JointState", "kind": "monitor_joints"},
        ]
        self.samples = {}
        self.arrivals = {topic["name"]: deque(maxlen=512) for topic in self.topics}
        self.connected = False
        self.disconnected_event = False
        self.error = None
        self.joint_publishers = None
        self.observer_subscription_failed = False
        self.task = None
        self.socket = None
        self.pending = {}
        self.pose_tests = PoseTests(self, state_dir) if state_dir is not None else None

    def start(self):
        if self.settings.ros_pc_ip and self.task is None:
            self.task = asyncio.create_task(self._run())

    async def stop(self):
        if self.task is not None:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task
            self.task = None
        if self.pose_tests and self.pose_tests.task:
            await self.pose_tests.task

    async def _run(self):
        host = self.settings.ros_pc_ip
        if ":" in host:
            host = f"[{host}]"
        endpoint = f"ws://{host}:{self.settings.rosbridge_port}"
        delay = 1
        while True:
            graph_task = None
            try:
                async with connect(endpoint, open_timeout=5, close_timeout=2,
                                   ping_interval=5, ping_timeout=5, max_size=262144, max_queue=4,
                                   proxy=None) as socket:
                    self.samples.clear()
                    for arrivals in self.arrivals.values():
                        arrivals.clear()
                    self.disconnected_event = False
                    self.error = None
                    self.observer_subscription_failed = False
                    for topic in self.topics:
                        await socket.send(json.dumps({"op": "subscribe", "id": topic["name"],
                            "topic": topic["name"], "type": topic["type"],
                            "throttle_rate": 0 if topic["kind"] == "event" else 100,
                            "queue_length": 1}))
                    self.connected = True
                    self.socket = socket
                    graph_task = asyncio.create_task(self._watch_joint_publishers(socket))
                    delay = 1
                    async for raw in socket:
                        self.receive(raw)
            except asyncio.CancelledError:
                raise
            except Exception:
                # Keep endpoint or remote payload details out of the UI and logs.
                self.error = "별도 ROS 2 컨트롤러의 유선 IP, rosbridge 포트와 실행 상태를 확인하세요."
            finally:
                self.connected = False
                self.socket = None
                self.joint_publishers = None
                if graph_task is not None:
                    graph_task.cancel()
                    with suppress(asyncio.CancelledError):
                        await graph_task
                for _, future in self.pending.values():
                    if not future.done():
                        future.set_exception(ConnectionError("rosbridge disconnected"))
            await asyncio.sleep(delay)
            delay = min(delay * 2, 10)

    async def _watch_joint_publishers(self, socket):
        # A subscription creates a ROS graph entry even when the driver is absent.
        # Only the publisher list can distinguish that case from a silent publisher.
        topic = self.topics[0]["name"]
        while socket is self.socket:
            try:
                result = await self.call_service(socket, "/rosapi/publishers", {"topic": topic}, timeout=3)
                nodes = result.get("publishers")
                self.joint_publishers = nodes if isinstance(nodes, list) and all(isinstance(n, str) for n in nodes) else None
                if self.disconnected_event and self.joint_publishers:
                    await self._check_driver_reconnected(socket)
            except (TimeoutError, RuntimeError, OSError, ConnectionClosed):
                self.joint_publishers = None
            await asyncio.sleep(5)

    async def _check_driver_reconnected(self, socket):
        lost = self.samples.get(self.topics[2]["name"])
        joints = self.samples.get(self.topics[0]["name"])
        if (not lost or not joints or joints["time"] <= lost["time"]
                or time.monotonic() - joints["time"] > self.settings.stale_seconds
                or len(joints["message"]["name"]) != 6
                or set(joints["message"]["name"]) != {f"joint_{i}" for i in range(1, 7)}):
            return
        state = await self.call_service(socket, "system/get_robot_state", {}, timeout=3)
        if (socket is self.socket and state.get("success") is True
                and self.samples.get(self.topics[2]["name"]) is lost):
            self.disconnected_event = False

    async def call_service(self, socket, suffix, args, timeout):
        if socket is not self.socket or not self.connected:
            raise ConnectionError("rosbridge disconnected")
        identifier = uuid4().hex
        service = suffix if suffix.startswith("/") else f"/{self.settings.namespace}/{suffix}"
        future = asyncio.get_running_loop().create_future()
        self.pending[identifier] = (service, future)
        try:
            async with asyncio.timeout(timeout):
                await socket.send(json.dumps({"op": "call_service", "id": identifier, "service": service,
                                              "args": args, "timeout": timeout - 1}))
                return await future
        finally:
            self.pending.pop(identifier, None)
            if not future.cancelled() and future.done():
                future.exception()

    def receive(self, raw):
        try:
            packet = json.loads(raw)
        except (ValueError, TypeError, UnicodeError):
            return
        if not isinstance(packet, dict):
            return
        identifier = packet.get("id")
        if isinstance(identifier, str) and identifier in self.pending:
            service, future = self.pending[identifier]
            if not future.done():
                if packet.get("op") == "service_response" and packet.get("service") == service:
                    if packet.get("result") is True and isinstance(packet.get("values"), dict):
                        future.set_result(packet["values"])
                    else:
                        future.set_exception(RuntimeError("ROS service rejected request"))
                elif packet.get("op") == "status" and packet.get("level") == "error":
                    future.set_exception(RuntimeError("rosbridge service error"))
            return
        if packet.get("op") == "status" and packet.get("level") == "error":
            if identifier == self.topics[3]["name"]:
                self.observer_subscription_failed = True
                return
            self.error = "토픽 구독 오류입니다. 네임스페이스와 ROS 메시지 패키지를 확인하세요."
            return
        topic = packet.get("topic")
        if not isinstance(topic, str) or topic not in self.arrivals or packet.get("op") != "publish":
            return
        message = packet.get("msg")
        if not isinstance(message, dict):
            return
        # Reject non-finite values before exposing the message as JSON through FastAPI.
        try:
            json.dumps(message, allow_nan=False)
        except (ValueError, TypeError):
            return
        if topic in (self.topics[0]["name"], self.topics[3]["name"]):
            names, positions = message.get("name"), message.get("position")
            if (not isinstance(names, list) or not isinstance(positions, list) or not names
                    or len(names) != len(positions) or len(names) > 64
                    or any(not isinstance(name, str) for name in names)
                    or any(type(value) not in (int, float) for value in positions)):
                return
        now = time.monotonic()
        self.samples[topic] = {"message": message, "time": now,
                               "received_at": datetime.now(timezone.utc).isoformat()}
        self.arrivals[topic].append(now)
        if topic == self.topics[2]["name"]:
            self.disconnected_event = True

    def snapshot(self):
        now = time.monotonic()
        topics = []
        for topic in self.topics:
            sample = self.samples.get(topic["name"])
            age = now - sample["time"] if sample else None
            recent = [stamp for stamp in self.arrivals[topic["name"]] if now - stamp <= 5]
            state = "waiting"
            if self.connected:
                state = "listening" if topic["kind"] == "event" else "waiting"
                if sample:
                    state = "received" if topic["kind"] == "event" else (
                        "live" if age <= self.settings.stale_seconds else "stale")
                if topic["kind"] == "joints" and state != "live" and self.joint_publishers == []:
                    state = "no_publisher"
                if topic["kind"] == "monitor_joints" and self.observer_subscription_failed:
                    state = "unavailable"
            rate = None
            if state == "live" and len(recent) > 1 and recent[-1] > recent[0]:
                rate = round((len(recent) - 1) / (recent[-1] - recent[0]), 1)
            topics.append({**topic, "state": state, "hz": rate,
                           "age_seconds": round(age, 2) if age is not None else None,
                           "received_at": sample["received_at"] if sample else None,
                           "message": sample["message"] if sample else None})
        state = "unconfigured"
        driver, observer = topics[0], topics[3]
        displayed = driver
        observer_is_newer = observer["received_at"] and (
            not driver["received_at"] or observer["received_at"] > driver["received_at"])
        if self.settings.ros_pc_ip:
            state = "offline"
            if self.connected:
                state = driver["state"]
                if self.disconnected_event:
                    state = "robot_disconnected"
                if state != "live" and observer["state"] == "live":
                    state = "monitoring"
                    displayed = observer
                elif state != "live" and observer_is_newer:
                    displayed = observer
                    state = "stale"
            elif observer_is_newer:
                displayed = observer
        return {"config": {**asdict(self.settings), "model": "e0509", "transport": "LAN"},
                "state": state, "bridge_connected": self.connected,
                "error": self.error, "topics": topics, "joint_publishers": self.joint_publishers,
                "display_joint_topic": displayed["name"],
                "pose_tests": self.pose_tests.snapshot() if self.pose_tests else None}


def require_robot_owner(request: Request):
    if request.app.state.robot is None:
        raise HTTPException(307, headers={"Location": "http://127.0.0.1:8080" + request.url.path})


router = APIRouter(prefix="/api/robot", dependencies=[Depends(require_robot_owner)])


@router.get("/status")
async def status(request: Request):
    return JSONResponse(request.app.state.robot.snapshot(), headers={"Cache-Control": "no-store"})


def same_site_json(request: Request):
    if (request.headers.get("sec-fetch-site") == "cross-site"
            or request.headers.get("content-type", "").split(";")[0].strip() != "application/json"):
        raise DomainError("로컬 로봇 모니터링 화면에서 요청하세요.", 403)


@router.put("/poses/{slot}", dependencies=[Depends(same_site_json)])
async def save_pose(slot: int, body: PoseInput, request: Request):
    return request.app.state.robot.pose_tests.save(slot, body)


@router.post("/poses/{slot}/execute", status_code=202, dependencies=[Depends(same_site_json)])
async def execute_pose(slot: int, body: PoseRevision, request: Request):
    return request.app.state.robot.pose_tests.execute(slot, body.revision)
