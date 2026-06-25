import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import { all, one, run } from "./src/db.js";
import { calendarAll, calendarDbConfigured, calendarSchema } from "./src/rl-calendar-db.js";
import { calculateForecast, regenerateRecommendations, weekIdForDate } from "./src/forecast.js";
import { importWorkbook } from "./scripts/import-workbook.js";
import { BATCH_TYPES } from "./src/master-products.js";

dotenv.config();

const app = express();
const upload = multer({ dest: path.resolve("data/uploads") });
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.resolve("public")));

function ok(res, data) {
  res.json({ ok: true, data });
}

function fail(res, error, status = 500) {
  console.error(error);
  res.status(status).json({ ok: false, error: error.message || String(error) });
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function findColumn(columns, candidates) {
  const normalized = new Map(columns.map((column) => [column.toLowerCase(), column]));
  for (const candidate of candidates) {
    if (normalized.has(candidate)) return normalized.get(candidate);
  }
  for (const column of columns) {
    const lower = column.toLowerCase();
    if (candidates.some((candidate) => lower.includes(candidate))) return column;
  }
  return null;
}

function selectRlBatchSource(schema) {
  const requested = process.env.TURSO_CALENDAR_TABLE;
  const candidates = requested
    ? schema.filter((table) => table.name === requested)
    : schema.filter((table) => /batch|schedule|calendar|production/i.test(table.name));
  const scored = candidates.map((table) => {
    const columns = table.columns.map((column) => column.toLowerCase());
    const score = [
      columns.some((column) => /date|week|start/.test(column)),
      columns.some((column) => /product|item|sku|name/.test(column)),
      columns.some((column) => /qty|quantity|amount|units/.test(column)),
    ].filter(Boolean).length;
    return { table, score };
  });
  return scored.sort((a, b) => b.score - a.score)[0]?.table || null;
}

function normalizeRlBatch(row, source) {
  const dateColumn = source.dateColumn;
  const productColumn = source.productColumn;
  const typeColumn = source.typeColumn;
  const qtyColumn = source.qtyColumn;
  const statusColumn = source.statusColumn;
  const notesColumn = source.notesColumn;
  return {
    id: row.id ?? row.batch_id ?? row.uuid ?? null,
    scheduled_date: dateColumn ? row[dateColumn] : null,
    product_name: productColumn ? row[productColumn] : "",
    batch_type: typeColumn ? row[typeColumn] : "",
    quantity: qtyColumn ? row[qtyColumn] : null,
    status: statusColumn ? row[statusColumn] : "",
    notes: notesColumn ? row[notesColumn] : "",
    raw: row,
  };
}

function productionIngredientFilters(query) {
  const where = ["pp.planned_qty > 0"];
  const params = {};
  if (query.batch_type && BATCH_TYPES.includes(query.batch_type)) {
    where.push("p.category = @batchType");
    params.batchType = query.batch_type;
  }
  if (query.start) {
    where.push("w.week_start >= @start");
    params.start = query.start;
  }
  if (query.end) {
    where.push("w.week_start <= @end");
    params.end = query.end;
  }
  return { where: where.join(" AND "), params };
}

async function productionIngredientReport(query = {}) {
  const { where, params } = productionIngredientFilters(query);
  const rows = await all(`
    SELECT i.name AS ingredient_name,
           'grams' AS quantity_uom,
           SUM(pp.planned_qty * COALESCE(pf.quantity_per_unit, 0)) AS required_qty,
           COUNT(DISTINCT p.id) AS product_count,
           GROUP_CONCAT(DISTINCT p.name) AS products,
           MIN(w.week_start) AS first_week,
           MAX(w.week_start) AS last_week
    FROM production_plan pp
    JOIN weeks w ON w.id = pp.week_id
    JOIN products p ON p.id = pp.product_id
    JOIN product_formulas pf ON pf.product_id = pp.product_id
    JOIN ingredients i ON i.id = pf.ingredient_id
    WHERE ${where}
    GROUP BY i.id
    ORDER BY i.name
  `, params);
  const detail = await all(`
    SELECT w.week_start,
           p.category AS batch_type,
           p.name AS product_name,
           pp.planned_qty,
           i.name AS ingredient_name,
           'grams' AS quantity_uom,
           COALESCE(pf.quantity_per_unit, 0) AS quantity_per_unit,
           pp.planned_qty * COALESCE(pf.quantity_per_unit, 0) AS required_qty
    FROM production_plan pp
    JOIN weeks w ON w.id = pp.week_id
    JOIN products p ON p.id = pp.product_id
    JOIN product_formulas pf ON pf.product_id = pp.product_id
    JOIN ingredients i ON i.id = pf.ingredient_id
    WHERE ${where}
    ORDER BY w.week_start, p.category, p.name, i.name
  `, params);
  return {
    filters: {
      batch_type: query.batch_type || "",
      start: query.start || "",
      end: query.end || "",
    },
    rows,
    detail,
  };
}

app.get("/api/health", async (req, res) => {
  try {
    const check = await one("SELECT 1 AS ok");
    ok(res, {
      database: check?.ok === 1 ? "connected" : "unknown",
      turso: Boolean(process.env.TURSO_DATABASE_URL),
      calendarTurso: calendarDbConfigured,
    });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/summary", async (req, res) => {
  try {
    const forecast = await calculateForecast();
    const shortages = forecast.rows.filter((r) => r.shortage).slice(0, 12);
    ok(res, {
      counts: {
        products: (await one("SELECT COUNT(*) AS n FROM products"))?.n || 0,
        ingredients: (await one("SELECT COUNT(*) AS n FROM ingredients"))?.n || 0,
        formulas: (await one("SELECT COUNT(*) AS n FROM product_formulas"))?.n || 0,
        weeks: (await one("SELECT COUNT(*) AS n FROM weeks"))?.n || 0,
      },
      imports: await all("SELECT * FROM imports ORDER BY imported_at DESC LIMIT 5"),
      upcomingProduction: await all(`
        SELECT w.week_start, p.name AS product_name, pp.planned_qty
        FROM production_plan pp
        JOIN products p ON p.id = pp.product_id
        JOIN weeks w ON w.id = pp.week_id
        WHERE pp.planned_qty > 0
        ORDER BY w.week_start, p.name
        LIMIT 20
      `),
      shortages,
      nextOrders: await all(`
        SELECT pr.*, i.name AS ingredient_name, ow.week_start AS order_week, nw.week_start AS needed_week
        FROM purchasing_recommendations pr
        JOIN ingredients i ON i.id = pr.ingredient_id
        JOIN weeks ow ON ow.id = pr.order_week_id
        JOIN weeks nw ON nw.id = pr.needed_week_id
        ORDER BY ow.week_start, i.name
        LIMIT 20
      `),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/weeks", async (req, res) => ok(res, await all("SELECT * FROM weeks ORDER BY week_start")));
app.get("/api/products", async (req, res) => ok(res, await all("SELECT * FROM products ORDER BY name")));
app.get("/api/ingredients", async (req, res) => {
  ok(res, await all("SELECT * FROM ingredients ORDER BY is_master DESC, name"));
});

app.post("/api/ingredients", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    if (!name) return fail(res, new Error("Item name is required"), 400);
    const existing = await one("SELECT * FROM ingredients WHERE lower(name) = lower(?)", [name]);
    if (existing) return fail(res, new Error("Inventory item already exists"), 400);
    const purchaseUom = String(req.body.purchase_uom || "").trim() || null;
    const purchaseUnitSize = Number(req.body.purchase_unit_size) || 0;
    const info = await run(
      `INSERT INTO ingredients
        (name, purchase_uom, purchase_unit_size, source_sheet, is_master, active)
       VALUES (?, ?, ?, 'Master Ingredient List', 1, 1)`,
      [name, purchaseUom, purchaseUnitSize],
    );
    ok(res, await one("SELECT * FROM ingredients WHERE id = ?", [info.lastInsertRowid]));
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/rl-scheduled-batches", async (req, res) => {
  try {
    if (!calendarDbConfigured) {
      return ok(res, {
        configured: false,
        source: null,
        schema: [],
        batches: [],
        message: "TURSO_CALENDAR_URL and TURSO_CALENDAR_TOKEN are not configured.",
      });
    }
    const schema = await calendarSchema();
    const table = selectRlBatchSource(schema);
    if (!table) {
      return ok(res, {
        configured: true,
        source: null,
        schema,
        batches: [],
        message: "No likely scheduled batch table was found in the RL calendar database.",
      });
    }
    const dateColumn = findColumn(table.columns, ["scheduled_date", "production_date", "date", "week_start", "start_date", "batch_date"]);
    const productColumn = findColumn(table.columns, ["product_name", "product", "item_name", "item", "sku", "name"]);
    const typeColumn = findColumn(table.columns, ["batch_type", "type", "category"]);
    const qtyColumn = findColumn(table.columns, ["quantity", "qty", "batch_qty", "amount", "units"]);
    const statusColumn = findColumn(table.columns, ["status", "state"]);
    const notesColumn = findColumn(table.columns, ["notes", "note", "description"]);
    if (!dateColumn || !productColumn) {
      return ok(res, {
        configured: true,
        source: { table: table.name, dateColumn, productColumn, typeColumn, qtyColumn, statusColumn, notesColumn },
        schema,
        batches: [],
        message: "The RL calendar table was found, but date and product columns could not both be identified.",
      });
    }
    const orderColumn = quoteIdentifier(dateColumn);
    const rows = await calendarAll(`SELECT * FROM ${quoteIdentifier(table.name)} ORDER BY ${orderColumn}`);
    const source = { table: table.name, dateColumn, productColumn, typeColumn, qtyColumn, statusColumn, notesColumn };
    ok(res, {
      configured: true,
      source,
      schema,
      batches: rows.map((row) => normalizeRlBatch(row, source)),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.patch("/api/ingredients/:id", async (req, res) => {
  try {
    const allowed = ["purchase_uom", "purchase_unit_size", "cost_per_purchase_uom", "cost_per_unit", "reorder_threshold", "lead_time_days"];
    const fields = Object.fromEntries(Object.entries(req.body).filter(([key]) => allowed.includes(key)));
    if (!Object.keys(fields).length) {
      return ok(res, await one("SELECT * FROM ingredients WHERE id = ?", [req.params.id]));
    }
    const sets = Object.keys(fields).map((key) => `${key} = @${key}`).join(", ");
    await run(`UPDATE ingredients SET ${sets} WHERE id = @id`, { ...fields, id: req.params.id });
    await regenerateRecommendations();
    ok(res, await one("SELECT * FROM ingredients WHERE id = ?", [req.params.id]));
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/production-plan", async (req, res) => {
  try {
    ok(res, {
      batchTypes: BATCH_TYPES,
      weeks: await all("SELECT * FROM weeks ORDER BY week_start"),
      products: await all(`
        SELECT *
        FROM products
        WHERE active = 1 AND category IN ('Hijnx', 'Snackbar')
        ORDER BY category, name
      `),
      plan: await all(`
        SELECT pp.*, p.name AS product_name, w.week_start
        FROM production_plan pp
        JOIN products p ON p.id = pp.product_id
        JOIN weeks w ON w.id = pp.week_id
        WHERE p.category IN ('Hijnx', 'Snackbar')
        ORDER BY p.name, w.week_start
      `),
      batches: await all(`
        SELECT pb.*, p.name AS product_name, w.week_start
        FROM production_batches pb
        JOIN products p ON p.id = pb.product_id
        JOIN weeks w ON w.id = pb.week_id
        ORDER BY w.week_start, pb.batch_type, p.name, pb.id
      `),
      recentBatches: await all(`
        SELECT pb.*, p.name AS product_name, w.week_start
        FROM production_batches pb
        JOIN products p ON p.id = pb.product_id
        JOIN weeks w ON w.id = pb.week_id
        ORDER BY pb.created_at DESC, pb.id DESC
        LIMIT 100
      `),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/production-plan", async (req, res) => {
  try {
    const { product_id, week_id, planned_qty } = req.body;
    await run(
      `INSERT INTO production_plan (product_id, week_id, planned_qty)
       VALUES (?, ?, ?)
       ON CONFLICT(product_id, week_id) DO UPDATE SET planned_qty = excluded.planned_qty`,
      [product_id, week_id, Number(planned_qty) || 0],
    );
    await regenerateRecommendations();
    ok(res, { product_id, week_id, planned_qty: Number(planned_qty) || 0 });
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/production-batches", async (req, res) => {
  try {
    const { batch_type, product_id, week_id, quantity, notes } = req.body;
    const product = await one("SELECT * FROM products WHERE id = ?", [product_id]);
    if (!product) return fail(res, new Error("Unknown product"), 400);
    if (!BATCH_TYPES.includes(batch_type) || product.category !== batch_type) {
      return fail(res, new Error("Product does not match selected batch type"), 400);
    }
    const qty = Number(quantity) || 0;
    if (qty <= 0) return fail(res, new Error("Quantity must be greater than zero"), 400);

    const info = await run(
      `INSERT INTO production_batches (batch_type, product_id, week_id, quantity, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [batch_type, product_id, week_id, qty, notes || null],
    );
    await run(
      `INSERT INTO production_plan (product_id, week_id, planned_qty)
       VALUES (?, ?, ?)
       ON CONFLICT(product_id, week_id) DO UPDATE
         SET planned_qty = planned_qty + excluded.planned_qty`,
      [product_id, week_id, qty],
    );
    await regenerateRecommendations();
    ok(res, { id: info.lastInsertRowid, batch_type, product_id, week_id, quantity: qty });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/forecast", async (req, res) => {
  try {
    const forecast = await calculateForecast();
    const ingredient = req.query.ingredient;
    const rows = ingredient
      ? forecast.rows.filter((row) => String(row.ingredient_id) === String(ingredient))
      : forecast.rows;
    ok(res, { ...forecast, rows });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/formulas", async (req, res) => {
  try {
    ok(res, {
      products: await all(`
        SELECT *
        FROM products
        WHERE active = 1 AND category IN ('Hijnx', 'Snackbar')
        ORDER BY category, name
      `),
      formulas: await all(`
        SELECT pf.*, p.name AS product_name, i.name AS ingredient_name
        FROM product_formulas pf
        JOIN products p ON p.id = pf.product_id
        JOIN ingredients i ON i.id = pf.ingredient_id
        WHERE p.category IN ('Hijnx', 'Snackbar')
        ORDER BY p.name, i.name
      `),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/formulas", async (req, res) => {
  try {
    const { product_id, ingredient_id, quantity_per_unit, notes } = req.body;
    const product = await one("SELECT * FROM products WHERE id = ?", [product_id]);
    if (!product || !BATCH_TYPES.includes(product.category)) {
      return fail(res, new Error("Select a valid production batch"), 400);
    }
    const ingredient = await one("SELECT * FROM ingredients WHERE id = ? AND is_master = 1", [ingredient_id]);
    if (!ingredient) return fail(res, new Error("Select a master ingredient"), 400);
    const gramsPerUnit = Number(quantity_per_unit) || 0;
    if (gramsPerUnit <= 0) return fail(res, new Error("Grams per unit must be greater than zero"), 400);
    const existing = await one(
      "SELECT id FROM product_formulas WHERE product_id = ? AND ingredient_id = ? ORDER BY source_sheet IS NULL DESC, id LIMIT 1",
      [product_id, ingredient_id],
    );
    if (existing) {
      await run(
        "UPDATE product_formulas SET quantity_per_unit = ?, quantity_uom = ?, notes = ? WHERE id = ?",
        [gramsPerUnit, "grams", notes || null, existing.id],
      );
    } else {
      await run(
        `INSERT INTO product_formulas
          (product_id, ingredient_id, quantity_per_unit, quantity_uom, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [product_id, ingredient_id, gramsPerUnit, "grams", notes || null],
      );
    }
    await regenerateRecommendations();
    ok(res, { product_id, ingredient_id });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/purchase-calendar", async (req, res) => {
  try {
    ok(res, {
      imported: await all(`
        SELECT pci.*, w.week_start, i.name AS ingredient_name
        FROM purchase_calendar_items pci
        LEFT JOIN weeks w ON w.id = pci.week_id
        LEFT JOIN ingredients i ON i.id = pci.ingredient_id
        ORDER BY w.week_start, pci.item_name
      `),
      recommendations: await all(`
        SELECT pr.*, i.name AS ingredient_name, ow.week_start AS order_week, nw.week_start AS needed_week
        FROM purchasing_recommendations pr
        JOIN ingredients i ON i.id = pr.ingredient_id
        JOIN weeks ow ON ow.id = pr.order_week_id
        JOIN weeks nw ON nw.id = pr.needed_week_id
        ORDER BY ow.week_start, i.name
      `),
      purchaseOrders: await all(`
        SELECT po.*, i.name AS ingredient_name, ow.week_start AS order_week, ew.week_start AS expected_week
        FROM purchase_orders po
        JOIN ingredients i ON i.id = po.ingredient_id
        LEFT JOIN weeks ow ON ow.id = po.order_week_id
        LEFT JOIN weeks ew ON ew.id = po.expected_week_id
        ORDER BY ow.week_start, i.name
      `),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/receiving", async (req, res) => {
  try {
    const { ingredient_id, date, week_id, quantity_received, notes } = req.body;
    const targetWeekId = week_id || await weekIdForDate(date);
    await run(
      `INSERT INTO received_inventory (ingredient_id, week_id, quantity_received, notes)
       VALUES (?, ?, ?, ?)`,
      [ingredient_id, targetWeekId, Number(quantity_received) || 0, notes || null],
    );
    await regenerateRecommendations();
    ok(res, { ingredient_id, week_id: targetWeekId, quantity_received: Number(quantity_received) || 0 });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/velocity", async (req, res) => {
  ok(res, await all("SELECT * FROM velocity_assumptions ORDER BY item_name"));
});

app.get("/api/reports", async (req, res) => {
  try {
    ok(res, {
      weeklyUsage: await all(`
        SELECT w.week_start, i.name AS ingredient_name,
               SUM(pp.planned_qty * COALESCE(pf.quantity_per_unit, 0)) AS required_usage,
               i.cost_per_unit,
               SUM(pp.planned_qty * COALESCE(pf.quantity_per_unit, 0) * COALESCE(i.cost_per_unit, 0)) AS projected_cost
        FROM production_plan pp
        JOIN weeks w ON w.id = pp.week_id
        JOIN product_formulas pf ON pf.product_id = pp.product_id
        JOIN ingredients i ON i.id = pf.ingredient_id
        GROUP BY w.id, i.id
        ORDER BY w.week_start, i.name
      `),
      monthlyCost: await all(`
        SELECT substr(w.week_start, 1, 7) AS month,
               SUM(pp.planned_qty * COALESCE(pf.quantity_per_unit, 0) * COALESCE(i.cost_per_unit, 0)) AS projected_cost
        FROM production_plan pp
        JOIN weeks w ON w.id = pp.week_id
        JOIN product_formulas pf ON pf.product_id = pp.product_id
        JOIN ingredients i ON i.id = pf.ingredient_id
        GROUP BY month
        ORDER BY month
      `),
      productCost: await all(`
        SELECT p.name AS product_name,
               SUM(COALESCE(pf.quantity_per_unit, 0) * COALESCE(i.cost_per_unit, 0)) AS ingredient_cost_per_unit,
               COUNT(*) AS ingredient_count
        FROM product_formulas pf
        JOIN products p ON p.id = pf.product_id
        JOIN ingredients i ON i.id = pf.ingredient_id
        GROUP BY p.id
        ORDER BY p.name
      `),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/production-ingredient-report", async (req, res) => {
  try {
    ok(res, await productionIngredientReport(req.query));
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/import/path", async (req, res) => {
  try {
    ok(res, await importWorkbook(req.body.path));
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/import/upload", upload.single("workbook"), async (req, res) => {
  try {
    if (!req.file) return fail(res, new Error("No workbook uploaded"), 400);
    ok(res, await importWorkbook(req.file.path));
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/export/production-ingredients", async (req, res) => {
  try {
    const report = await productionIngredientReport(req.query);
    const summary = report.rows.map((row) => ({
      Ingredient: row.ingredient_name,
      "Needed Qty": row.required_qty,
      UOM: row.quantity_uom,
      Products: row.products,
      "First Week": row.first_week,
      "Last Week": row.last_week,
    }));
    const detail = report.detail.map((row) => ({
      Week: row.week_start,
      "Batch Type": row.batch_type,
      Product: row.product_name,
      "Planned Qty": row.planned_qty,
      Ingredient: row.ingredient_name,
      "Qty Per Unit": row.quantity_per_unit,
      "Needed Qty": row.required_qty,
      UOM: row.quantity_uom,
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary), "Ingredient Needs");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detail), "Production Detail");
    const outDir = path.resolve("exports");
    fs.mkdirSync(outDir, { recursive: true });
    const cleanType = report.filters.batch_type || "both";
    const cleanStart = report.filters.start || "all";
    const cleanEnd = report.filters.end || "all";
    const file = path.join(outDir, `production-ingredients-${cleanType}-${cleanStart}-${cleanEnd}-${Date.now()}.xlsx`);
    XLSX.writeFile(wb, file);
    res.download(file);
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/export/:kind", async (req, res) => {
  try {
    const kind = req.params.kind;
    const forecast = kind === "forecast" ? await calculateForecast() : null;
    const datasets = {
      ingredients: await all("SELECT * FROM ingredients ORDER BY name"),
      production: await all(`
        SELECT p.name AS product_name, w.week_start, pp.planned_qty
        FROM production_plan pp JOIN products p ON p.id = pp.product_id JOIN weeks w ON w.id = pp.week_id
        ORDER BY p.name, w.week_start
      `),
      forecast: forecast?.rows,
      recommendations: await all(`
        SELECT i.name AS ingredient_name, ow.week_start AS order_week, nw.week_start AS needed_week,
               pr.recommended_qty, pr.projected_ending_qty, pr.estimated_cost, pr.reason
        FROM purchasing_recommendations pr
        JOIN ingredients i ON i.id = pr.ingredient_id
        JOIN weeks ow ON ow.id = pr.order_week_id
        JOIN weeks nw ON nw.id = pr.needed_week_id
        ORDER BY ow.week_start, i.name
      `),
    };
    const data = datasets[kind];
    if (!data) return fail(res, new Error("Unknown export kind"), 404);
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, kind.slice(0, 31));
    const outDir = path.resolve("exports");
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${kind}-${Date.now()}.xlsx`);
    XLSX.writeFile(wb, file);
    res.download(file);
  } catch (error) {
    fail(res, error);
  }
});

app.listen(port, () => {
  console.log(`Planning app listening on http://localhost:${port}`);
  if (process.env.TURSO_DATABASE_URL) {
    console.log("TURSO_DATABASE_URL is configured. Using TURSO_DATABASE_TOKEN/TURSO_AUTH_TOKEN for auth.");
  }
});
