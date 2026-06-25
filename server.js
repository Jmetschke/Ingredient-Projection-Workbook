import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import XLSX from "xlsx";
import { all, one, run } from "./src/db.js";
import { calendarAll, calendarDbConfigured, calendarSchema } from "./src/rl-calendar-db.js";
import { calculateForecast, regenerateRecommendations, weekIdForDate } from "./src/forecast.js";
import { BATCH_TYPES } from "./src/master-products.js";
import { bomUomForIngredient } from "./src/master-ingredients.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.resolve("public")));

function ok(res, data) {
  res.json({ ok: true, data });
}

function withBomUom(row) {
  return row ? { ...row, bom_uom: bomUomForIngredient(row.name) } : row;
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

function valueFromColumns(row, columns) {
  for (const column of columns) {
    if (column && row[column] !== undefined && row[column] !== null && row[column] !== "") return row[column];
  }
  return null;
}

function selectRlBatchSource(schema) {
  const requested = process.env.TURSO_CALENDAR_TABLE;
  const candidates = requested
    ? schema.filter((table) => table.name === requested)
    : schema;
  const scored = candidates.map((table) => {
    const columns = table.columns.map((column) => column.toLowerCase());
    const score = [
      /batch|schedule|calendar|production|event|task/i.test(table.name),
      columns.some((column) => /date|week|start/.test(column)),
      columns.some((column) => /product|item|sku|name|title/.test(column)),
      columns.some((column) => /qty|quantity|amount|units/.test(column)),
    ].filter(Boolean).length;
    return { table, score };
  });
  return scored.sort((a, b) => b.score - a.score)[0]?.table || null;
}

function normalizeRlBatch(row, source) {
  const scheduledDate = valueFromColumns(row, source.dateColumns);
  const productName = valueFromColumns(row, source.productColumns);
  const title = valueFromColumns(row, source.titleColumns);
  const type = valueFromColumns(row, source.typeColumns);
  const category = valueFromColumns(row, source.categoryColumns);
  const quantity = valueFromColumns(row, source.qtyColumns);
  const completion = valueFromColumns(row, source.completionColumns);
  const status = valueFromColumns(row, source.statusColumns);
  const notes = valueFromColumns(row, source.notesColumns);
  const units = valueFromColumns(row, source.unitColumns);
  return {
    id: row.id ?? row.batch_id ?? row.uuid ?? null,
    scheduled_date: scheduledDate,
    product_name: productName || title || "",
    title: title || productName || "",
    batch_type: type || category || "",
    category: category || type || "",
    quantity,
    quantity_uom: units || "",
    completion,
    status: status || "",
    notes: notes || "",
    raw: row,
  };
}

function completionFromChecklist(checklist = {}) {
  const values = Object.values(checklist || {});
  if (!values.length) return null;
  const completed = values.filter(Boolean).length;
  return Math.round((completed / values.length) * 100);
}

function parseRlScheduleTasks(row) {
  let tasks;
  try {
    tasks = JSON.parse(row.tasks || "{}");
  } catch {
    return [];
  }
  const groups = [
    { key: "batchHijnx", batchType: "Hijnx", category: "hijnx" },
    { key: "batchSb", batchType: "SB", category: "sb" },
  ];
  return groups.flatMap((group) => {
    const entries = Array.isArray(tasks[group.key]) ? tasks[group.key] : [];
    return entries.map((entry, index) => ({
      id: `${row.schedule_date}:${group.key}:${index}:${entry.item || ""}`,
      scheduled_date: row.schedule_date,
      product_name: entry.item || "",
      title: entry.item || "",
      batch_type: group.batchType,
      category: group.category,
      quantity: entry.units ?? "",
      quantity_uom: "units",
      completion: completionFromChecklist(entry.checklist),
      status: "",
      notes: "",
      raw: entry,
    }));
  });
}

function isScheduleDaysSource(table) {
  return table?.name === "schedule_days"
    && table.columns.includes("schedule_date")
    && table.columns.includes("tasks");
}

function localIsoDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDateDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function mondayForDate(date = new Date()) {
  const day = date.getDay();
  const daysSinceMonday = (day + 6) % 7;
  return addDateDays(date, -daysSinceMonday);
}

async function ensureForwardWeeks(count = 78) {
  const start = mondayForDate(new Date());
  for (let index = 0; index < count; index += 1) {
    const weekStart = localIsoDate(addDateDays(start, index * 7));
    await run(
      `INSERT INTO weeks (week_start, label)
       VALUES (?, ?)
       ON CONFLICT(week_start) DO NOTHING`,
      [weekStart, weekStart],
    );
  }
}

function productionIngredientFilters(query) {
  const where = ["pb.quantity > 0"];
  const params = {};
  if (query.batch_type && BATCH_TYPES.includes(query.batch_type)) {
    where.push("pb.batch_type = @batchType");
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
           COALESCE(pf.quantity_uom, 'grams') AS quantity_uom,
           SUM(pb.quantity * COALESCE(pf.quantity_per_unit, 0)) AS required_qty,
           COUNT(DISTINCT p.id) AS product_count,
           GROUP_CONCAT(DISTINCT p.name) AS products,
           MIN(w.week_start) AS first_week,
           MAX(w.week_start) AS last_week
    FROM production_batches pb
    JOIN weeks w ON w.id = pb.week_id
    JOIN products p ON p.id = pb.product_id
    JOIN product_formulas pf ON pf.product_id = pb.product_id AND pf.source_sheet IS NULL
    JOIN ingredients i ON i.id = pf.ingredient_id
    WHERE ${where}
    GROUP BY i.id, COALESCE(pf.quantity_uom, 'grams')
    ORDER BY i.name, quantity_uom
  `, params);
  const detail = await all(`
    SELECT w.week_start,
           pb.batch_type,
           p.name AS product_name,
           pb.quantity AS planned_qty,
           i.name AS ingredient_name,
           COALESCE(pf.quantity_uom, 'grams') AS quantity_uom,
           COALESCE(pf.quantity_per_unit, 0) AS quantity_per_unit,
           pb.quantity * COALESCE(pf.quantity_per_unit, 0) AS required_qty
    FROM production_batches pb
    JOIN weeks w ON w.id = pb.week_id
    JOIN products p ON p.id = pb.product_id
    JOIN product_formulas pf ON pf.product_id = pb.product_id AND pf.source_sheet IS NULL
    JOIN ingredients i ON i.id = pf.ingredient_id
    WHERE ${where}
    ORDER BY w.week_start, pb.batch_type, p.name, i.name
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

function forecastDateWindow(months = 6) {
  const today = new Date();
  const start = mondayForDate(today);
  const end = new Date(start);
  end.setMonth(end.getMonth() + months);
  return {
    start: localIsoDate(start),
    end: localIsoDate(end),
  };
}

async function scheduledIngredientUsageForecast(query = {}) {
  const monthCount = [6, 9, 12].includes(Number(query.months)) ? Number(query.months) : 6;
  const { start, end } = forecastDateWindow(monthCount);
  const rows = await all(`
    SELECT i.id AS ingredient_id,
           i.name AS ingredient_name,
           COALESCE(pf.quantity_uom, 'grams') AS quantity_uom,
           SUM(pb.quantity * COALESCE(pf.quantity_per_unit, 0)) AS required_qty,
           COUNT(DISTINCT pb.id) AS scheduled_batches,
           COUNT(DISTINCT p.id) AS product_count,
           GROUP_CONCAT(DISTINCT p.name) AS products,
           MIN(w.week_start) AS first_week,
           MAX(w.week_start) AS last_week
    FROM production_batches pb
    JOIN weeks w ON w.id = pb.week_id
    JOIN products p ON p.id = pb.product_id
    JOIN product_formulas pf ON pf.product_id = pb.product_id AND pf.source_sheet IS NULL
    JOIN ingredients i ON i.id = pf.ingredient_id
    WHERE pb.quantity > 0
      AND w.week_start >= @start
      AND w.week_start < @end
    GROUP BY i.id, COALESCE(pf.quantity_uom, 'grams')
    HAVING required_qty > 0
    ORDER BY i.name, quantity_uom
  `, { start, end });
  const detail = await all(`
    SELECT w.week_start,
           pb.batch_type,
           p.name AS product_name,
           pb.quantity AS batch_qty,
           i.id AS ingredient_id,
           i.name AS ingredient_name,
           COALESCE(pf.quantity_uom, 'grams') AS quantity_uom,
           COALESCE(pf.quantity_per_unit, 0) AS quantity_per_unit,
           pb.quantity * COALESCE(pf.quantity_per_unit, 0) AS required_qty
    FROM production_batches pb
    JOIN weeks w ON w.id = pb.week_id
    JOIN products p ON p.id = pb.product_id
    JOIN product_formulas pf ON pf.product_id = pb.product_id AND pf.source_sheet IS NULL
    JOIN ingredients i ON i.id = pf.ingredient_id
    WHERE pb.quantity > 0
      AND w.week_start >= @start
      AND w.week_start < @end
    ORDER BY w.week_start, i.name, p.name
  `, { start, end });
  return {
    filters: { months: monthCount, start, end },
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
      upcomingProduction: await all(`
        SELECT w.week_start, pb.batch_type, p.name AS product_name, SUM(pb.quantity) AS planned_qty
        FROM production_batches pb
        JOIN products p ON p.id = pb.product_id
        JOIN weeks w ON w.id = pb.week_id
        WHERE pb.quantity > 0
        GROUP BY w.id, pb.batch_type, p.id
        ORDER BY w.week_start, pb.batch_type, p.name
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

app.get("/api/weeks", async (req, res) => {
  try {
    await ensureForwardWeeks();
    ok(res, await all("SELECT id, week_start, label FROM weeks ORDER BY week_start"));
  } catch (error) {
    fail(res, error);
  }
});
app.get("/api/products", async (req, res) => {
  ok(res, await all("SELECT id, name, sku, category, active FROM products ORDER BY name"));
});
app.get("/api/ingredients", async (req, res) => {
  const rows = await all(`
    SELECT id, name, purchase_uom, purchase_unit_size, cost_per_purchase_uom, cost_per_unit,
      reorder_threshold, lead_time_days, supplier_id, is_master, active
    FROM ingredients
    ORDER BY is_master DESC, name
  `);
  ok(res, rows.map(withBomUom));
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
        (name, purchase_uom, purchase_unit_size, is_master, active)
       VALUES (?, ?, ?, 1, 1)`,
      [name, purchaseUom, purchaseUnitSize],
    );
    ok(res, withBomUom(await one(`
      SELECT id, name, purchase_uom, purchase_unit_size, cost_per_purchase_uom, cost_per_unit,
        reorder_threshold, lead_time_days, supplier_id, is_master, active
      FROM ingredients
      WHERE id = ?
    `, [info.lastInsertRowid])));
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
    if (isScheduleDaysSource(table)) {
      const rows = await calendarAll(`
        SELECT schedule_date, tasks, updated_at
        FROM ${quoteIdentifier(table.name)}
        ORDER BY schedule_date
      `);
      return ok(res, {
        configured: true,
        source: {
          table: table.name,
          mode: "schedule_days_json",
          dateColumns: ["schedule_date"],
          taskColumn: "tasks",
          batchArrays: ["batchHijnx", "batchSb"],
          productField: "item",
          quantityField: "units",
        },
        schema,
        batches: rows.flatMap(parseRlScheduleTasks),
      });
    }
    const source = {
      table: table.name,
      dateColumns: [
        findColumn(table.columns, ["scheduled_date", "production_date", "calendar_date", "due_date", "date", "week_start", "start_date", "batch_date"]),
        findColumn(table.columns, ["created_for", "scheduled_for"]),
      ].filter(Boolean),
      productColumns: [
        findColumn(table.columns, ["product_name", "product", "item_name", "item", "sku", "name"]),
      ].filter(Boolean),
      titleColumns: [
        findColumn(table.columns, ["title", "summary", "description", "label"]),
      ].filter(Boolean),
      typeColumns: [
        findColumn(table.columns, ["batch_type", "production_type", "type"]),
      ].filter(Boolean),
      categoryColumns: [
        findColumn(table.columns, ["category", "calendar_type", "event_type", "kind"]),
      ].filter(Boolean),
      qtyColumns: [
        findColumn(table.columns, ["quantity", "qty", "batch_qty", "amount", "units", "unit_count"]),
      ].filter(Boolean),
      unitColumns: [
        findColumn(table.columns, ["quantity_uom", "uom", "unit", "units_label"]),
      ].filter(Boolean),
      completionColumns: [
        findColumn(table.columns, ["completion", "completion_percent", "percent_complete", "progress", "completed_percent"]),
      ].filter(Boolean),
      statusColumns: [
        findColumn(table.columns, ["status", "state"]),
      ].filter(Boolean),
      notesColumns: [
        findColumn(table.columns, ["notes", "note", "description", "details"]),
      ].filter(Boolean),
    };
    if (!source.dateColumns.length || (!source.productColumns.length && !source.titleColumns.length)) {
      return ok(res, {
        configured: true,
        source,
        schema,
        batches: [],
        message: "The RL calendar table was found, but date and product columns could not both be identified.",
      });
    }
    const orderColumn = quoteIdentifier(source.dateColumns[0]);
    const rows = await calendarAll(`SELECT * FROM ${quoteIdentifier(table.name)} ORDER BY ${orderColumn}`);
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
      return ok(res, withBomUom(await one(`
        SELECT id, name, purchase_uom, purchase_unit_size, cost_per_purchase_uom, cost_per_unit,
          reorder_threshold, lead_time_days, supplier_id, is_master, active
        FROM ingredients
        WHERE id = ?
      `, [req.params.id])));
    }
    const sets = Object.keys(fields).map((key) => `${key} = @${key}`).join(", ");
    await run(`UPDATE ingredients SET ${sets} WHERE id = @id`, { ...fields, id: req.params.id });
    await regenerateRecommendations();
    ok(res, withBomUom(await one(`
      SELECT id, name, purchase_uom, purchase_unit_size, cost_per_purchase_uom, cost_per_unit,
        reorder_threshold, lead_time_days, supplier_id, is_master, active
      FROM ingredients
      WHERE id = ?
    `, [req.params.id])));
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/production-plan", async (req, res) => {
  try {
    await ensureForwardWeeks();
    ok(res, {
      batchTypes: BATCH_TYPES,
      weeks: await all("SELECT id, week_start, label FROM weeks ORDER BY week_start"),
      products: await all(`
        SELECT id, name, sku, category, active
        FROM products
        WHERE active = 1 AND category IN ('Hijnx', 'Snackbar')
        ORDER BY category, name
      `),
      plan: await all(`
        SELECT pb.product_id, pb.week_id, SUM(pb.quantity) AS planned_qty, p.name AS product_name, w.week_start
        FROM production_batches pb
        JOIN products p ON p.id = pb.product_id
        JOIN weeks w ON w.id = pb.week_id
        WHERE pb.batch_type IN ('Hijnx', 'Snackbar')
        GROUP BY pb.product_id, pb.week_id
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
    await regenerateRecommendations();
    ok(res, { id: info.lastInsertRowid, batch_type, product_id, week_id, quantity: qty });
  } catch (error) {
    fail(res, error);
  }
});

app.patch("/api/production-batches/:id", async (req, res) => {
  try {
    const existing = await one("SELECT * FROM production_batches WHERE id = ?", [req.params.id]);
    if (!existing) return fail(res, new Error("Scheduled batch not found"), 404);

    const batchType = req.body.batch_type || existing.batch_type;
    const productId = req.body.product_id || existing.product_id;
    const weekId = req.body.week_id || existing.week_id;
    const qty = Number(req.body.quantity ?? existing.quantity) || 0;
    const notes = req.body.notes ?? existing.notes;
    const product = await one("SELECT * FROM products WHERE id = ?", [productId]);
    if (!product) return fail(res, new Error("Unknown product"), 400);
    if (!BATCH_TYPES.includes(batchType) || product.category !== batchType) {
      return fail(res, new Error("Product does not match selected batch type"), 400);
    }
    if (qty <= 0) return fail(res, new Error("Quantity must be greater than zero"), 400);

    await run(
      `UPDATE production_batches
       SET batch_type = ?, product_id = ?, week_id = ?, quantity = ?, notes = ?
       WHERE id = ?`,
      [batchType, productId, weekId, qty, notes || null, req.params.id],
    );
    await regenerateRecommendations();
    ok(res, { id: Number(req.params.id), batch_type: batchType, product_id: productId, week_id: weekId, quantity: qty });
  } catch (error) {
    fail(res, error);
  }
});

app.delete("/api/production-batches/:id", async (req, res) => {
  try {
    const result = await run("DELETE FROM production_batches WHERE id = ?", [req.params.id]);
    if (!result.changes) return fail(res, new Error("Scheduled batch not found"), 404);
    await regenerateRecommendations();
    ok(res, { id: Number(req.params.id) });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/forecast", async (req, res) => {
  try {
    ok(res, await scheduledIngredientUsageForecast(req.query));
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/formulas", async (req, res) => {
  try {
    ok(res, {
      products: await all(`
        SELECT id, name, sku, category, active
        FROM products
        WHERE active = 1 AND category IN ('Hijnx', 'Snackbar')
        ORDER BY category, name
      `),
      formulas: await all(`
        SELECT pf.id, pf.product_id, pf.ingredient_id, pf.quantity_per_unit, pf.quantity_uom, pf.notes,
          p.name AS product_name, i.name AS ingredient_name
        FROM product_formulas pf
        JOIN products p ON p.id = pf.product_id
        JOIN ingredients i ON i.id = pf.ingredient_id
        WHERE p.category IN ('Hijnx', 'Snackbar') AND pf.source_sheet IS NULL
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
    const quantityPerUnit = Number(quantity_per_unit) || 0;
    if (quantityPerUnit <= 0) return fail(res, new Error("BOM quantity per unit must be greater than zero"), 400);
    const quantityUom = bomUomForIngredient(ingredient.name);
    const existing = await one(
      "SELECT id FROM product_formulas WHERE product_id = ? AND ingredient_id = ? AND source_sheet IS NULL LIMIT 1",
      [product_id, ingredient_id],
    );
    if (existing) {
      await run(
        "UPDATE product_formulas SET quantity_per_unit = ?, quantity_uom = ?, notes = ? WHERE id = ?",
        [quantityPerUnit, quantityUom, notes || null, existing.id],
      );
    } else {
      await run(
        `INSERT INTO product_formulas
          (product_id, ingredient_id, quantity_per_unit, quantity_uom, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [product_id, ingredient_id, quantityPerUnit, quantityUom, notes || null],
      );
    }
    await regenerateRecommendations();
    ok(res, { product_id, ingredient_id });
  } catch (error) {
    fail(res, error);
  }
});

app.patch("/api/formulas/:id", async (req, res) => {
  try {
    const existing = await one(`
      SELECT pf.*, p.category, i.name AS ingredient_name
      FROM product_formulas pf
      JOIN products p ON p.id = pf.product_id
      JOIN ingredients i ON i.id = pf.ingredient_id
      WHERE pf.id = ? AND pf.source_sheet IS NULL
    `, [req.params.id]);
    if (!existing) return fail(res, new Error("BOM ingredient not found"), 404);
    const ingredientId = req.body.ingredient_id || existing.ingredient_id;
    const ingredient = await one("SELECT * FROM ingredients WHERE id = ? AND is_master = 1", [ingredientId]);
    if (!ingredient) return fail(res, new Error("Select a master ingredient"), 400);
    const duplicate = await one(
      "SELECT id FROM product_formulas WHERE product_id = ? AND ingredient_id = ? AND source_sheet IS NULL AND id <> ? LIMIT 1",
      [existing.product_id, ingredientId, req.params.id],
    );
    if (duplicate) return fail(res, new Error("That ingredient is already on this BOM"), 400);
    const quantityPerUnit = Number(req.body.quantity_per_unit ?? existing.quantity_per_unit) || 0;
    if (quantityPerUnit <= 0) return fail(res, new Error("BOM quantity per unit must be greater than zero"), 400);
    const quantityUom = bomUomForIngredient(ingredient.name);
    await run(
      "UPDATE product_formulas SET ingredient_id = ?, quantity_per_unit = ?, quantity_uom = ?, notes = ? WHERE id = ?",
      [ingredientId, quantityPerUnit, quantityUom, req.body.notes ?? existing.notes ?? null, req.params.id],
    );
    await regenerateRecommendations();
    ok(res, { id: Number(req.params.id), ingredient_id: ingredientId, quantity_per_unit: quantityPerUnit, quantity_uom: quantityUom });
  } catch (error) {
    fail(res, error);
  }
});

app.delete("/api/formulas/:id", async (req, res) => {
  try {
    const result = await run("DELETE FROM product_formulas WHERE id = ? AND source_sheet IS NULL", [req.params.id]);
    if (!result.changes) return fail(res, new Error("BOM ingredient not found"), 404);
    await regenerateRecommendations();
    ok(res, { id: Number(req.params.id) });
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

app.get("/api/production-ingredient-report", async (req, res) => {
  try {
    ok(res, await productionIngredientReport(req.query));
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

app.listen(port, () => {
  console.log(`Planning app listening on http://localhost:${port}`);
  if (process.env.TURSO_DATABASE_URL) {
    console.log("TURSO_DATABASE_URL is configured. Using TURSO_DATABASE_TOKEN/TURSO_AUTH_TOKEN for auth.");
  }
});
