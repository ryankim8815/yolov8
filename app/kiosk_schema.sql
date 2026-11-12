CREATE TABLE IF NOT EXISTS kiosk_orders (
    order_id INTEGER PRIMARY KEY REFERENCES orders(id), request_id TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kiosk_order_lines (
    order_id INTEGER NOT NULL REFERENCES kiosk_orders(order_id),
    product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL, unit TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK(quantity BETWEEN 1 AND 99), position INTEGER NOT NULL,
    PRIMARY KEY(order_id, product_id), UNIQUE(order_id, position)
);
DROP VIEW inventory;
CREATE VIEW inventory AS
    SELECT p.*, COALESCE(r.reserved,0) AS reserved, p.stock-COALESCE(r.reserved,0) AS available
    FROM products p LEFT JOIN (
        SELECT i.product_id,COUNT(*) AS reserved FROM order_items i JOIN orders o ON o.id=i.order_id
        WHERE i.done=0 AND (o.state='packing' OR (o.state='received' AND
            EXISTS (SELECT 1 FROM kiosk_orders k WHERE k.order_id=o.id)))
        GROUP BY i.product_id
    ) r ON r.product_id=p.id;
