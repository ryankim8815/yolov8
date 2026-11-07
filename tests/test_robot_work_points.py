import json
import os
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.robot import RobotMonitor, RobotSettings
from app.robot_web import create_robot_app


class WorkPointTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = directory.name
        self.enterContext(patch.dict(os.environ, {"ROBOT_STATE_DIR": self.root, "ROBOT_ROS_PC_IP": ""}))
        self.app = create_robot_app()
        self.client = self.enterContext(TestClient(self.app))
        self.robot = self.app.state.robot
        self.url = "/api/robot/work-points/"
        self.pose = [200, -150.5, 189.7, -179, 90, 0]

    def test_independent_persistent_base_poses_without_a_connection(self):
        self.robot.call_service = AsyncMock()
        points = self.client.get("/api/robot/status").json()["work_points"]
        self.assertEqual({k: p["pose"] for k, p in points.items()}, {"box": None, "shipping_label": None})
        saved = {}
        for name, pose in [("box", self.pose), ("shipping_label", [0]*6)]:
            response = self.client.put(self.url + name, json={"pose": pose, "revision": None})
            self.assertEqual(response.status_code, 200, response.text)
            saved[name] = response.json()
        # Stale edits don't clobber another tab; updating the label leaves the box intact.
        body = {"pose": [1]*6, "revision": None}
        self.assertEqual(self.client.put(self.url + "shipping_label", json=body).status_code, 409)
        body["revision"] = saved["shipping_label"]["revision"]
        saved["shipping_label"] = self.client.put(self.url + "shipping_label", json=body).json()
        self.assertEqual(saved["shipping_label"]["pose"], [1]*6)
        self.assertEqual(RobotMonitor(self.robot.settings, self.root).work_points.points, saved)
        self.assertIsNone(RobotMonitor(RobotSettings(namespace="other"), self.root).work_points.points["box"]["pose"])
        self.assertFalse(self.robot.pose_tests.path.exists())
        self.robot.call_service.assert_not_awaited()

    def test_rejects_invalid_input_and_cross_site_writes(self):
        for pose in ([0]*3, [0]*7, [0, 0, 0, 0, 0, False], ["1"]*6):
            response = self.client.put(self.url + "box", json={"pose": pose, "revision": None})
            self.assertEqual(response.status_code, 422)
        body = {"pose": self.pose, "revision": None}
        self.assertEqual(self.client.put(self.url + "unknown", json=body).status_code, 422)
        self.assertEqual(self.client.put(self.url + "box", json=body, headers={"Sec-Fetch-Site":"cross-site"}).status_code, 403)
        self.assertFalse(self.robot.work_points.path.exists())

    def test_capture_requires_fresh_monitor_and_valid_task_pose_and_never_saves(self):
        self.robot.call_service = AsyncMock(return_value={"success": True, "pos": self.pose})
        url = self.url + "current"
        self.assertEqual(self.client.get(url).status_code, 503)
        self.robot.connected, self.robot.socket = True, object()
        topic = self.robot.topics[3]["name"]
        self.robot.receive(json.dumps({"op":"publish", "topic":topic, "msg":{"name":["joint_1"], "position":[1]}}))
        response = self.client.get(url)
        self.assertEqual(response.json(), {"pose": self.pose})
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.robot.call_service.assert_awaited_once_with(self.robot.socket, "monitor/get_current_pose", {"space_type":1}, timeout=4)
        for values in ({"success": False, "pos": [0]*6}, {"success": True, "pos": [0]*5},
                       {"success": True, "pos": [float("nan")]*6}):
            self.robot.call_service.return_value = values
            self.assertEqual(self.client.get(url).status_code, 503)
        self.robot.call_service.side_effect = TimeoutError()
        self.assertEqual(self.client.get(url).status_code, 503)
        self.robot.samples[topic]["time"] -= 30
        self.robot.call_service.reset_mock()
        self.assertEqual(self.client.get(url).status_code, 503)
        self.robot.call_service.assert_not_awaited()
        self.assertFalse(self.robot.work_points.path.exists())
