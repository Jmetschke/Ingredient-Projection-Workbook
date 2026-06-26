PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS weeks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL UNIQUE,
  label TEXT
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sku TEXT,
  category TEXT,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  purchase_uom TEXT,
  ingredient_type TEXT NOT NULL DEFAULT 'SB/Hijnx',
  purchase_unit_size REAL,
  cost_per_purchase_uom REAL,
  cost_per_unit REAL,
  reorder_threshold REAL,
  lead_time_days INTEGER DEFAULT 0,
  supplier_id INTEGER REFERENCES suppliers(id),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ingredient_costs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  effective_week_id INTEGER REFERENCES weeks(id) ON DELETE SET NULL,
  cost_per_unit REAL NOT NULL,
  cost_per_purchase_uom REAL
);

CREATE TABLE IF NOT EXISTS product_formulas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  quantity_per_unit REAL,
  quantity_uom TEXT,
  source_sheet TEXT,
  source_cell TEXT,
  source_formula TEXT,
  notes TEXT,
  UNIQUE(product_id, ingredient_id, source_sheet, source_cell)
);

CREATE TABLE IF NOT EXISTS production_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_type TEXT NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  quantity REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_batch_sizes (
  product_id INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
  batch_size REAL NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  supplier_id INTEGER REFERENCES suppliers(id),
  order_week_id INTEGER REFERENCES weeks(id) ON DELETE SET NULL,
  expected_week_id INTEGER REFERENCES weeks(id) ON DELETE SET NULL,
  quantity_ordered REAL NOT NULL DEFAULT 0,
  unit_cost REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'planned',
  notes TEXT
);

CREATE TABLE IF NOT EXISTS received_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  quantity_received REAL NOT NULL DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS purchasing_recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  needed_week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  order_week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
  recommended_qty REAL NOT NULL,
  projected_ending_qty REAL NOT NULL,
  estimated_cost REAL NOT NULL DEFAULT 0,
  reason TEXT,
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(ingredient_id, needed_week_id)
);

CREATE INDEX IF NOT EXISTS idx_batches_product_week ON production_batches(product_id, week_id);
CREATE INDEX IF NOT EXISTS idx_batches_week ON production_batches(week_id);
CREATE INDEX IF NOT EXISTS idx_batch_sizes_product ON product_batch_sizes(product_id);
CREATE INDEX IF NOT EXISTS idx_formula_product ON product_formulas(product_id);
CREATE INDEX IF NOT EXISTS idx_formula_ingredient ON product_formulas(ingredient_id);
CREATE INDEX IF NOT EXISTS idx_receipts_week ON received_inventory(week_id);
CREATE INDEX IF NOT EXISTS idx_po_week ON purchase_orders(order_week_id);
