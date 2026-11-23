-- =====================================================================
-- Inventory Management Website - PostgreSQL schema (Supabase compatible)
-- Safe to run more than once. Paste into the Supabase SQL editor or run
-- with:  npm run db:setup
-- =====================================================================

-- ---------- Users & access ------------------------------------------
CREATE TABLE IF NOT EXISTS roles (
  role_id      SERIAL PRIMARY KEY,
  role_key     TEXT UNIQUE NOT NULL,
  role_name    TEXT UNIQUE NOT NULL,
  description  TEXT
);

CREATE TABLE IF NOT EXISTS permissions (
  permission_id   SERIAL PRIMARY KEY,
  permission_key  TEXT UNIQUE NOT NULL,
  description     TEXT
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id        INT NOT NULL REFERENCES roles(role_id) ON DELETE CASCADE,
  permission_id  INT NOT NULL REFERENCES permissions(permission_id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS users (
  user_id              SERIAL PRIMARY KEY,
  role_id              INT NOT NULL REFERENCES roles(role_id),
  full_name            TEXT NOT NULL,
  username             TEXT,
  email                TEXT NOT NULL,
  phone                TEXT,
  password_hash        TEXT NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  preferences          JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_login_at        TIMESTAMPTZ,
  reset_token_hash     TEXT,
  reset_token_expires  TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_uq ON users (lower(username)) WHERE username IS NOT NULL;

-- ---------- Product catalog -----------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  category_id    SERIAL PRIMARY KEY,
  category_name  TEXT UNIQUE NOT NULL,
  description    TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  supplier_id    SERIAL PRIMARY KEY,
  supplier_name  TEXT NOT NULL,
  contact_person TEXT,
  phone          TEXT,
  email          TEXT,
  address        TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  product_id     SERIAL PRIMARY KEY,
  category_id    INT REFERENCES categories(category_id) ON DELETE SET NULL,
  supplier_id    INT REFERENCES suppliers(supplier_id) ON DELETE SET NULL,
  sku            TEXT UNIQUE NOT NULL,
  product_name   TEXT NOT NULL,
  description    TEXT,
  unit_price     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  cost_price     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
  quantity       INT NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  reorder_level  INT NOT NULL DEFAULT 10 CHECK (reorder_level >= 0),
  expiry_date    DATE,
  image_url      TEXT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_category_idx ON products (category_id);
CREATE INDEX IF NOT EXISTS products_supplier_idx ON products (supplier_id);
CREATE INDEX IF NOT EXISTS products_name_idx ON products (lower(product_name));

-- ---------- Purchasing ----------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_orders (
  purchase_id    SERIAL PRIMARY KEY,
  supplier_id    INT NOT NULL REFERENCES suppliers(supplier_id),
  created_by     INT REFERENCES users(user_id) ON DELETE SET NULL,
  purchase_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','received','cancelled')),
  total_amount   NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes          TEXT,
  received_at    TIMESTAMPTZ,
  received_by    INT REFERENCES users(user_id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS purchase_orders_status_idx ON purchase_orders (status);

CREATE TABLE IF NOT EXISTS purchase_items (
  purchase_item_id  SERIAL PRIMARY KEY,
  purchase_id       INT NOT NULL REFERENCES purchase_orders(purchase_id) ON DELETE CASCADE,
  product_id        INT NOT NULL REFERENCES products(product_id),
  quantity          INT NOT NULL CHECK (quantity > 0),
  unit_cost         NUMERIC(12,2) NOT NULL CHECK (unit_cost >= 0)
);
CREATE INDEX IF NOT EXISTS purchase_items_purchase_idx ON purchase_items (purchase_id);

-- ---------- Orders & sales ------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  order_id        SERIAL PRIMARY KEY,
  customer_name   TEXT NOT NULL DEFAULT 'Walk-in customer',
  customer_phone  TEXT,
  created_by      INT REFERENCES users(user_id) ON DELETE SET NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','cancelled')),
  total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);
CREATE INDEX IF NOT EXISTS orders_created_idx ON orders (created_at);

CREATE TABLE IF NOT EXISTS order_items (
  order_item_id  SERIAL PRIMARY KEY,
  order_id       INT NOT NULL REFERENCES orders(order_id) ON DELETE CASCADE,
  product_id     INT NOT NULL REFERENCES products(product_id),
  quantity       INT NOT NULL CHECK (quantity > 0),
  unit_price     NUMERIC(12,2) NOT NULL CHECK (unit_price >= 0),
  unit_cost      NUMERIC(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_product_idx ON order_items (product_id);

CREATE TABLE IF NOT EXISTS sales (
  sale_id         SERIAL PRIMARY KEY,
  order_id        INT NOT NULL UNIQUE REFERENCES orders(order_id) ON DELETE CASCADE,
  sold_by         INT REFERENCES users(user_id) ON DELETE SET NULL,
  payment_method  TEXT NOT NULL CHECK (payment_method IN ('cash','card','upi','bank_transfer')),
  amount_paid     NUMERIC(12,2) NOT NULL CHECK (amount_paid >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sales_created_idx ON sales (created_at);

-- ---------- Stock history -------------------------------------------
CREATE TABLE IF NOT EXISTS stock_transactions (
  transaction_id    SERIAL PRIMARY KEY,
  product_id        INT NOT NULL REFERENCES products(product_id),
  user_id           INT REFERENCES users(user_id) ON DELETE SET NULL,
  transaction_type  TEXT NOT NULL CHECK (transaction_type IN
    ('initial','stock_in','stock_out','damaged','expired','adjustment','purchase_received','order','order_cancelled')),
  quantity_change   INT NOT NULL,
  quantity_after    INT NOT NULL,
  reason            TEXT,
  reference_type    TEXT,
  reference_id      INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_tx_product_idx ON stock_transactions (product_id);
CREATE INDEX IF NOT EXISTS stock_tx_created_idx ON stock_transactions (created_at);

-- ---------- Common application features ----------------------------
CREATE TABLE IF NOT EXISTS notifications (
  notification_id  SERIAL PRIMARY KEY,
  user_id          INT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  message          TEXT,
  type             TEXT NOT NULL DEFAULT 'info',
  link             TEXT,
  dedupe_key       TEXT,
  is_read          BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, is_read, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_unread_dedupe_uq
  ON notifications (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND is_read = FALSE;

CREATE TABLE IF NOT EXISTS activity_logs (
  log_id      SERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(user_id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity      TEXT,
  entity_id   INT,
  details     JSONB,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_user_idx ON activity_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_created_idx ON activity_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS support_requests (
  request_id  SERIAL PRIMARY KEY,
  user_id     INT REFERENCES users(user_id) ON DELETE SET NULL,
  subject     TEXT NOT NULL,
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Roles, permissions and the permission matrix -------------
INSERT INTO roles (role_key, role_name, description) VALUES
  ('owner',            'Owner',            'Business overview and user administration'),
  ('product_manager',  'Product Manager',  'Products and categories'),
  ('sales_manager',    'Sales Manager',    'Sales operations and payments'),
  ('stock_manager',    'Stock Manager',    'Stock levels and stock movements'),
  ('purchase_manager', 'Purchase Manager', 'Purchase orders, suppliers and receiving'),
  ('order_manager',    'Order Manager',    'Customer orders and order workflow')
ON CONFLICT (role_key) DO NOTHING;

INSERT INTO permissions (permission_key, description) VALUES
  ('users.manage',     'Create users, change roles, reset passwords, view all activity'),
  ('finance.view',     'See profit figures'),
  ('products.read',    'View products'),
  ('products.write',   'Create, edit and deactivate products'),
  ('categories.read',  'View categories'),
  ('categories.write', 'Create, edit and delete categories'),
  ('suppliers.read',   'View suppliers'),
  ('suppliers.write',  'Create, edit and deactivate suppliers'),
  ('stock.read',       'View stock levels and movements'),
  ('stock.write',      'Record stock in, stock out and adjustments'),
  ('purchases.read',   'View purchase orders'),
  ('purchases.write',  'Create, receive and cancel purchase orders'),
  ('orders.read',      'View orders'),
  ('orders.write',     'Create orders and change order status'),
  ('sales.read',       'View sales and invoices'),
  ('sales.write',      'Record sales and payments'),
  ('reports.view',     'Generate permitted reports'),
  ('analytics.view',   'View permitted analytics')
ON CONFLICT (permission_key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.role_id, p.permission_id
FROM (VALUES
  ('owner','users.manage'),('owner','finance.view'),('owner','products.read'),('owner','categories.read'),
  ('owner','suppliers.read'),('owner','stock.read'),('owner','purchases.read'),('owner','orders.read'),
  ('owner','sales.read'),('owner','reports.view'),('owner','analytics.view'),

  ('product_manager','products.read'),('product_manager','products.write'),
  ('product_manager','categories.read'),('product_manager','categories.write'),
  ('product_manager','suppliers.read'),('product_manager','reports.view'),('product_manager','analytics.view'),

  ('sales_manager','sales.read'),('sales_manager','sales.write'),('sales_manager','orders.read'),
  ('sales_manager','products.read'),('sales_manager','reports.view'),('sales_manager','analytics.view'),

  ('stock_manager','stock.read'),('stock_manager','stock.write'),('stock_manager','products.read'),
  ('stock_manager','categories.read'),('stock_manager','categories.write'),('stock_manager','products.write'),('stock_manager','suppliers.read'),
  ('stock_manager','reports.view'),('stock_manager','analytics.view'),

  ('purchase_manager','purchases.read'),('purchase_manager','purchases.write'),('purchase_manager','stock.read'),
  ('purchase_manager','suppliers.read'),('purchase_manager','suppliers.write'),
  ('purchase_manager','products.read'),('purchase_manager','reports.view'),('purchase_manager','analytics.view'),

  ('order_manager','orders.read'),('order_manager','orders.write'),('order_manager','products.read'),
  ('order_manager','reports.view'),('order_manager','analytics.view')
) AS m(role_key, permission_key)
JOIN roles r ON r.role_key = m.role_key
JOIN permissions p ON p.permission_key = m.permission_key
ON CONFLICT DO NOTHING;

-- ---------- Supabase: lock the tables away from the public Data API ---
-- The Express backend connects directly with the database password and is
-- unaffected. Enabling RLS with no policies stops anyone using the public
-- anon key from reading tables such as users.password_hash.
ALTER TABLE roles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE permissions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE users               ENABLE ROW LEVEL SECURITY;
ALTER TABLE categories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers           ENABLE ROW LEVEL SECURITY;
ALTER TABLE products            ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders     ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales               ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications       ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_logs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_requests    ENABLE ROW LEVEL SECURITY;
