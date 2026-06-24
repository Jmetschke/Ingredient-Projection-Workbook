import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import XLSX from "xlsx";
import { all, one, run } from "./src/db.js";
import { calculateForecast, regenerateRecommendations, weekIdForDate } from "./src/forecast.js";
import { importWorkbook } from "./scripts/import-workbook.js";

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

app.get("/api/health", async (req, res) => {
  try {
    const check = await one("SELECT 1 AS ok");
    ok(res, {
      database: check?.ok === 1 ? "connected" : "unknown",
      turso: Boolean(process.env.TURSO_DATABASE_URL),
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
app.get("/api/ingredients", async (req, res) => ok(res, await all("SELECT * FROM ingredients ORDER BY name")));

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
      weeks: await all("SELECT * FROM weeks ORDER BY week_start"),
      products: await all("SELECT * FROM products WHERE active = 1 ORDER BY name"),
      plan: await all(`
        SELECT pp.*, p.name AS product_name, w.week_start
        FROM production_plan pp
        JOIN products p ON p.id = pp.product_id
        JOIN weeks w ON w.id = pp.week_id
        ORDER BY p.name, w.week_start
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
      formulas: await all(`
        SELECT pf.*, p.name AS product_name, i.name AS ingredient_name
        FROM product_formulas pf
        JOIN products p ON p.id = pf.product_id
        JOIN ingredients i ON i.id = pf.ingredient_id
        ORDER BY p.name, i.name
      `),
      sourceLines: await all(`
        SELECT ftl.*, p.name AS product_name
        FROM formula_tab_lines ftl
        LEFT JOIN products p ON p.id = ftl.product_id
        ORDER BY ftl.sheet_name, ftl.row_number
      `),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/formulas", async (req, res) => {
  try {
    const { product_id, ingredient_id, quantity_per_unit, quantity_uom, notes } = req.body;
    const existing = await one(
      "SELECT id FROM product_formulas WHERE product_id = ? AND ingredient_id = ? AND source_sheet IS NULL LIMIT 1",
      [product_id, ingredient_id],
    );
    if (existing) {
      await run(
        "UPDATE product_formulas SET quantity_per_unit = ?, quantity_uom = ?, notes = ? WHERE id = ?",
        [Number(quantity_per_unit) || 0, quantity_uom || null, notes || null, existing.id],
      );
    } else {
      await run(
        `INSERT INTO product_formulas
          (product_id, ingredient_id, quantity_per_unit, quantity_uom, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [product_id, ingredient_id, Number(quantity_per_unit) || 0, quantity_uom || null, notes || null],
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
