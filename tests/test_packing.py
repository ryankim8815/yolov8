import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


class PackingTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings = Settings(camera_autostart=False)
        self.app = create_app(self.settings, state_root=self.temp.name)

    def test_simultaneous_retries_restart_and_reservations(self):
        with TestClient(self.app) as c:
            state = c.get("/api/packing").json()
            self.assertEqual([p["stock"] for p in state["products"]], [10, 5, 3, 1, 2])
            self.assertEqual([p["reserved"] for p in state["products"]], [1, 1, 0, 1, 0])
            self.assertEqual(state["products"][3]["available"], 0)
            items = state["orders"][0]["items"]
            paths = [f"/api/packing/orders/123/items/{i['id']}/complete" for i in items]
            self.assertEqual(c.put(paths[1]).status_code, 409)
            self.assertEqual(c.put("/api/packing/orders/123/pause", json={"paused": True}).status_code, 200)
            self.assertEqual(c.put(paths[0]).status_code, 409)
            c.put("/api/packing/orders/123/pause", json={"paused": False})
            bad = c.put("/api/packing/products/PK-004/stock", json={"stock": 0, "expected_stock": 1})
            self.assertEqual(bad.status_code, 409)
            self.assertIn("예약 수량 1개", bad.json()["detail"])
            for path in paths:
                with ThreadPoolExecutor(2) as pool:
                    responses = list(pool.map(c.put, [path, path]))
                self.assertTrue(all(r.status_code == 200 for r in responses))
            stale = c.put("/api/packing/products/PK-001/stock", json={"stock": 15, "expected_stock": 10})
            self.assertEqual(stale.status_code, 409)
        with TestClient(create_app(self.settings, state_root=self.temp.name)) as c:
            self.assertEqual(c.put(paths[-1]).status_code, 200)
            state = c.get("/api/packing").json()
            self.assertEqual([p["stock"] for p in state["products"]], [9, 4, 3, 0, 2])
            self.assertEqual([p["reserved"] for p in state["products"]], [0] * 5)
            self.assertEqual(state["orders"][0]["state"], "awaiting_dispatch")
            self.assertEqual(len([e for e in state["events"] if e["source"] == "패킹" and "출고" in e["message"]]), 3)

    def test_bindings_are_exclusive_versioned_and_persistent(self):
        with TestClient(self.app) as c:
            data = c.get("/api/packing").json()
            self.assertEqual(c.get("/api/status").json()["state"], "camera_off")
            version = data["model"]["id"]
            base = f"/api/packing/models/{version}"
            water = base + "/products/PK-002/class"
            snack = base + "/products/PK-001/class"
            bottle = next(i["id"] for i in data["model"]["classes"] if i["name"] == "bottle")
            self.assertTrue(all(i["sku"] is None for i in data["model"]["classes"]))
            self.assertEqual(c.put(water, json={"class_id": bottle}).status_code, 200)
            self.assertEqual(c.put(snack, json={"class_id": bottle}).status_code, 409)
            self.assertEqual(c.put(water, json={"class_id": 999}).status_code, 422)
            rt = self.app.state.pipeline
            rt.store.put("model", {"id": "other", "name": "다른 모델", "classes": [{"id": bottle, "name": "bottle"}]})
            self.assertIsNone(c.get("/api/packing/models/other/classes").json()["classes"][0]["sku"])
            self.assertEqual(c.put("/api/packing/models/other/products/PK-002/class", json={"class_id": bottle}).status_code, 409)
        with TestClient(create_app(self.settings, state_root=self.temp.name)) as c:
            assigned = lambda: [i for i in c.get(base + "/classes").json()["classes"] if i["sku"]]
            self.assertEqual([(i["sku"], i["id"]) for i in assigned()], [("PK-002", bottle)])
            self.assertEqual(c.put(water, json={"class_id": 0}).status_code, 200)
            self.assertEqual([i["id"] for i in assigned()], [0])
            self.assertEqual(c.put(water, json={"class_id": None}).status_code, 200)
            self.assertEqual(assigned(), [])

    def test_product_registration_and_adjustment_with_camera_off(self):
        with TestClient(self.app) as c:
            result = c.post("/api/packing/products", json={"name": " 추가 상품 ", "stock": 7})
            self.assertEqual(result.status_code, 201)
            sku = result.json()["sku"]
            path = f"/api/packing/products/{sku}/stock"
            self.assertEqual(c.put(path, json={"stock": -1, "expected_stock": 7}).status_code, 422)
            self.assertEqual(c.put(path, json={"stock": 4, "expected_stock": 7}).status_code, 200)
            self.assertEqual(c.get("/api/packing/products").json()[-1]["available"], 4)
            self.assertEqual(c.put("/api/packing/orders/124").json()["state"], "received")
            self.assertEqual(c.put("/api/packing/orders/124").status_code, 200)
            self.assertEqual(len(c.get("/api/packing").json()["orders"]), 2)
