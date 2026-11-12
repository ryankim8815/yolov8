"""Quantity-only buyer orders share inventory and packing state."""
import hashlib
import json
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .robot_access_protocol import LOCAL_ORIGINS
from .store import DomainError, now

CATEGORIES = ("간식·음료", "식품", "생활용품", "기타")
DEFAULT_CATEGORIES = {"빼빼로":"간식·음료", "생수":"간식·음료", "스팸":"식품", "물티슈":"생활용품", "인형":"생활용품"}


class OrderLine(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, str_strip_whitespace=True)
    sku: str = Field(min_length=1, max_length=80)
    quantity: int = Field(ge=1, le=99)


class OrderInput(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    request_id: str = Field(pattern=r"^[0-9a-f]{32}$")
    customer_id: int = Field(gt=0, le=9007199254740991)
    items: list[OrderLine] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def unique_and_bounded(self):
        if len({line.sku for line in self.items}) != len(self.items):
            raise ValueError("같은 상품은 수량으로 합쳐 주세요.")
        if sum(line.quantity for line in self.items) > 100:
            raise ValueError("한 번에 최대 100개까지 주문할 수 있습니다.")
        return self


def local_order(request: Request):
    if (request.headers.get("sec-fetch-site") == "cross-site"
            or request.headers.get("origin") and request.headers["origin"] not in LOCAL_ORIGINS
            or request.headers.get("content-type", "").partition(";")[0].strip() != "application/json"):
        raise HTTPException(403, "현재 키오스크 화면에서 주문을 확인하세요.")


class Kiosk:
    def __init__(self, packing):
        self.packing = packing
        self.store = packing.store

    def catalog(self):
        with self.store.read_transaction():
            rows = self.store.db.execute("SELECT sku,name,unit,available FROM inventory ORDER BY id")
            products=[{**dict(row), "category":DEFAULT_CATEGORIES.get(row["name"],"기타")} for row in rows]
            return {"products": products, "categories":[c for c in CATEGORIES if any(p["category"]==c for p in products)],
                    "pickup": "매장 상품 수령대"}

    def customers(self):
        with self.store.read_transaction():
            return {"customers": [dict(row) for row in self.store.db.execute("""
                SELECT id,name FROM customers WHERE kiosk_guest=0
                AND name<>'키오스크 방문 고객' AND trim(name)<>'' ORDER BY id
            """)]}

    def receipt(self, request_id):
        with self.store.read_transaction():
            row = self.store.db.execute("""
                SELECT o.number,o.state,o.paused,k.created_at,k.order_id,k.request_id,
                       o.customer_id,coalesce(k.customer_name,c.name) AS customer_name,c.kiosk_guest
                FROM kiosk_orders k JOIN orders o ON o.id=k.order_id
                JOIN customers c ON c.id=o.customer_id WHERE k.request_id=?
            """, (request_id,)).fetchone()
            if not row:
                raise DomainError("접수된 주문이 없습니다.", 404)
            items = [dict(r) for r in self.store.db.execute("""
                SELECT p.sku,l.name,l.unit,l.quantity
                FROM kiosk_order_lines l JOIN products p ON p.id=l.product_id
                WHERE l.order_id=? ORDER BY l.position
            """, (row["order_id"],))]
            return {k: row[k] for k in ("number", "state", "created_at", "request_id")} | {
                "pickup_number": f"K-{row['number']:03d}", "paused": bool(row["paused"]),
                "items": items, "quantity": sum(i["quantity"] for i in items), "pickup": "매장 상품 수령대",
                "customer": {"id": row["customer_id"], "name": row["customer_name"], "is_guest": bool(row["kiosk_guest"])}}

    def place(self, data):
        # One writer reservation covers stock checks and retries across processes.
        canonical = sorted((line.model_dump() for line in data.items), key=lambda line: line["sku"])
        fingerprint = hashlib.sha256(json.dumps({"customer_id":data.customer_id,"items":canonical}, sort_keys=True).encode()).hexdigest()
        with self.store.write_transaction() as write:
            existing = self.store.db.execute("SELECT payload_hash FROM kiosk_orders WHERE request_id=?", (data.request_id,)).fetchone()
            if existing:
                if existing["payload_hash"] != fingerprint:
                    raise DomainError("같은 주문 요청 번호에 다른 주문자나 상품을 사용할 수 없습니다.")
                return self.receipt(data.request_id)
            customer = self.store.db.execute("""SELECT id,name FROM customers
                WHERE id=? AND kiosk_guest=0 AND name<>'키오스크 방문 고객' AND trim(name)<>''""",
                (data.customer_id,)).fetchone()
            if not customer:
                raise DomainError("사용자 관리에 등록된 주문자를 다시 선택하세요.")
            products = []
            for line in data.items:
                product = self.store.db.execute("SELECT * FROM inventory WHERE sku=?", (line.sku,)).fetchone()
                if not product:
                    raise DomainError("주문할 상품을 찾을 수 없습니다.")
                if product["available"] < line.quantity:
                    raise DomainError(product["name"] + f"은 현재 {max(0,product['available'])}개까지 주문할 수 있습니다.")
                products.append((product, line))
            # 124 is reserved by the existing voice-order example.
            number = self.store.db.execute("SELECT max(124,coalesce(max(number),124))+1 FROM orders").fetchone()[0]
            public_id = f"packing-{number}"
            units = [p["id"] for p,line in products for _ in range(line.quantity)]
            # Bind the selected numeric identity directly; names are not unique.
            order_id = self.store.db.execute("""
                INSERT INTO orders(public_id,number,customer_id,paused,state) VALUES (?,?,?,0,'received')
            """, (public_id,number,customer["id"])).lastrowid
            self.store.db.executemany("""
                INSERT INTO order_items(public_id,order_id,position,product_id,done) VALUES (?,?,?,?,0)
            """, [(f"{number}-{i+1}",order_id,i,product_id) for i,product_id in enumerate(units)])
            self.store.db.execute("""INSERT INTO kiosk_orders(order_id,request_id,payload_hash,created_at,customer_name)
                                    VALUES (?,?,?,?,?)""", (order_id,data.request_id,fingerprint,now(),customer["name"]))
            self.store.db.executemany("INSERT INTO kiosk_order_lines VALUES (?,?,?,?,?,?)",
                                     [(order_id, p["id"], p["name"], p["unit"], line.quantity, i)
                                      for i, (p, line) in enumerate(products)])
            self.packing.log(write, "주문", f"키오스크 주문 #{number} 접수 · {customer['name']}(#{customer['id']}) · {len(units)}개 · 매장 수령")
            return self.receipt(data.request_id)


router = APIRouter(prefix="/api/kiosk")


def service(request):
    return Kiosk(request.app.state.pipeline.packing)


@router.get("/catalog")
def catalog(request: Request):
    return service(request).catalog()


@router.get("/customers")
def customers(request: Request):
    return service(request).customers()


@router.post("/orders", dependencies=[Depends(local_order)], status_code=201)
def place(body: OrderInput, request: Request):
    return service(request).place(body)


@router.get("/orders/{request_id}")
def receipt(request_id: str, request: Request):
    try:
        parsed = UUID(request_id)
    except ValueError:
        raise HTTPException(404, "주문 요청 번호를 확인하세요.")
    if parsed.hex != request_id:
        raise HTTPException(404, "주문 요청 번호를 확인하세요.")
    return service(request).receipt(request_id)
