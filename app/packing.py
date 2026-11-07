"""SQLite-backed inventory, class assignments and packing orders."""
from .store import DomainError, now, uid

SEED_PRODUCTS = (
    ("PK-001", "빼빼로", 10), ("PK-002", "생수", 5), ("PK-003", "스팸", 3),
    ("PK-004", "물티슈", 1), ("PK-005", "인형", 2),
)
ORDER_SKUS = ("PK-001", "PK-002", "PK-004")


class Packing:
    def __init__(self, store):
        self.store = store
        with store.write_transaction() as write:
            if not store.list("packing_order"):
                for sku, name, stock in SEED_PRODUCTS:
                    write("product", self.product(sku, name, "개", stock))
                write("packing_order", self.new_order(123, "packing"))
                self.log(write, "주문", "주문 #123 접수 · 빼빼로, 생수, 물티슈 각 1개 예약")

    @staticmethod
    def product(sku, name, unit, stock, alias="", bin=""):
        return {"id": sku, "sku": sku, "name": name, "unit": unit, "stock": stock,
                "alias": alias or name, "bin": bin}

    @staticmethod
    def new_order(number, state):
        return {"id": f"packing-{number}", "number": number, "customer": "홍길동", "paused": False,
                "state": state, "items": [{"id": f"{number}-{i}", "sku": sku, "done": False}
                                          for i, sku in enumerate(ORDER_SKUS, 1)]}

    @staticmethod
    def log(write, source, message):
        write("packing_event", {"id": uid("packing-event"), "time": now(), "source": source, "message": message})

    def products(self):
        return [dict(r) for r in self.store.db.execute(
            "SELECT sku AS id,sku,name,unit,stock,alias,bin,reserved,available FROM inventory ORDER BY inventory.id")]

    def create_product(self, name, unit, stock, alias, bin):
        with self.store.write_transaction() as write:
            # SKU is an external business code; products.id is assigned by SQLite.
            sku = self.store.db.execute(
                "SELECT printf('PK-%03d',1+coalesce(max(CAST(substr(sku,4) AS INTEGER)),0)) "
                "FROM products WHERE sku GLOB 'PK-[0-9]*' AND substr(sku,4) NOT GLOB '*[^0-9]*'").fetchone()[0]
            product = self.product(sku, name, unit, stock, alias, bin)
            write("product", product)
            self.log(write, "재고", f"{name} 등록 · 보유 {stock}{unit}")
            return product

    def adjust(self, sku, stock, expected_stock):
        with self.store.write_transaction() as write:
            product = self.store.get("product", sku)
            reserved = self.store.db.execute("SELECT reserved FROM inventory WHERE sku=?", (sku,)).fetchone()[0]
            if stock < reserved:
                raise DomainError(f"예약 수량 {reserved}{product['unit']} 이상으로 입력하세요.")
            if product["stock"] != expected_stock:
                raise DomainError("보유 수량이 변경되었습니다. 최신 수량을 확인한 후 다시 조정하세요.")
            if stock != product["stock"]:
                write("product", {**product, "stock": stock})
                self.log(write, "재고", f"{product['name']} 보유 수량 조정 · {stock}{product['unit']}")

    def order(self, number):
        return self.store.get("packing_order", f"packing-{number}")

    def complete(self, number, item_id):
        with self.store.write_transaction() as write:
            order = self.order(number)
            item = next((i for i in order["items"] if i["id"] == item_id), None)
            if item is None:
                raise DomainError("주문에 없는 품목입니다.", 404)
            if item["done"]:
                return order
            if order["state"] != "packing" or order["paused"]:
                raise DomainError("현재 포장을 진행할 수 없습니다.")
            if next(i for i in order["items"] if not i["done"]) != item:
                raise DomainError("화면에 표시된 다음 품목부터 포장하세요.")
            product = self.store.get("product", item["sku"])
            if product["stock"] < 1:
                raise DomainError("보유 수량이 부족합니다.")
            order_key = self.store.relations.keys.local("orders", order["id"])
            self.store.db.execute("UPDATE order_items SET done=1 WHERE order_id=? AND public_id=? AND done=0",
                                  (order_key, item_id))
            self.store.db.execute("UPDATE products SET stock=stock-1 WHERE sku=?", (item["sku"],))
            self.log(write, "패킹", f"주문 #{number} · {product['name']} 1{product['unit']} 놓기 완료 · 출고 반영")
            if not self.store.db.execute("SELECT 1 FROM order_items WHERE order_id=? AND done=0 LIMIT 1",
                                         (order_key,)).fetchone():
                self.store.db.execute("UPDATE orders SET state='awaiting_dispatch' WHERE id=?", (order_key,))
                self.log(write, "배송", f"주문 #{number} 포장 완료 · 발송 대기")
            return self.order(number)

    def pause(self, number, paused):
        with self.store.write_transaction() as write:
            order = self.order(number)
            if order["state"] == "packing" and order["paused"] != paused:
                order["paused"] = paused
                self.store.db.execute("UPDATE orders SET paused=? WHERE public_id=?", (paused, order["id"]))
                self.log(write, "패킹", f"주문 #{number} 작업 " + ("정지" if paused else "재개"))
            return order

    def receive_example(self):
        with self.store.write_transaction() as write:
            if not any(o["number"] == 124 for o in self.store.list("packing_order")):
                write("packing_order", self.new_order(124, "received"))
                self.log(write, "주문", "주문 #124 접수 · 박스 판독 대기")
            return self.order(124)

    def model_classes(self, model_id):
        model = self.store.db.execute(
            "SELECT m.public_id AS id,coalesce(a.name,m.name,m.public_id) AS name FROM models m "
            "LEFT JOIN model_aliases a ON a.model_id=m.id WHERE m.public_id=?", (model_id,)).fetchone()
        if model is None:
            raise DomainError("model: 항목을 찾을 수 없습니다", 404)
        classes = self.store.db.execute(
            "SELECT c.class_id AS id,c.name,p.sku FROM model_classes c "
            "LEFT JOIN product_class_bindings b USING(model_id,class_id) "
            "LEFT JOIN products p ON p.id=b.product_id "
            "WHERE c.model_id=(SELECT id FROM models WHERE public_id=?) ORDER BY c.position", (model_id,))
        return {**dict(model), "classes": [dict(c) for c in classes]}

    def assign(self, model_id, sku, class_id):
        with self.store.write_transaction() as write:
            self.store.get("product", sku)
            classes = self.model_classes(model_id)["classes"]
            if class_id is not None:
                target = next((c for c in classes if c["id"] == class_id), None)
                if target is None:
                    raise DomainError("모델에 등록된 클래스를 선택하세요.", 422)
                if target["sku"] and target["sku"] != sku:
                    other = self.store.get("product", target["sku"])
                    raise DomainError(f"이미 {other['name']}에 연결된 클래스입니다.")
            self.store.db.execute(
                "DELETE FROM product_class_bindings WHERE model_id=(SELECT id FROM models WHERE public_id=?) "
                "AND product_id=(SELECT id FROM products WHERE sku=?)", (model_id, sku))
            if class_id is not None:
                write("product_class", {"id": uid("binding"), "model_id": model_id, "class_id": class_id,
                                        "label": target["name"], "sku": sku})

    def snapshot(self, model_id):
        with self.store.read_transaction():
            orders = self.store.list("packing_order")
            return {"products": self.products(), "orders": orders, "model": self.model_classes(model_id),
                    "events": self.store.list("packing_event")}
