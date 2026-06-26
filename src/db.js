import fs from "node:fs";
import path from "node:path";
import { createClient } from "@libsql/client";
import dotenv from "dotenv";
import { EACH_UOM_INGREDIENTS, MASTER_INGREDIENTS } from "./master-ingredients.js";
import { MASTER_PRODUCTS, STANDARD_BATCH_SIZES } from "./master-products.js";

dotenv.config();

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_DATABASE_TOKEN || process.env.TURSO_AUTH_TOKEN;
const localPath = process.env.DATABASE_PATH || "./data/planning.db";
const databaseUrl = tursoUrl || `file:${path.resolve(localPath)}`;

if (!tursoUrl) {
  fs.mkdirSync(path.dirname(path.resolve(localPath)), { recursive: true });
}

export const db = createClient({
  url: databaseUrl,
  authToken: tursoToken,
});

function normalizeRows(result) {
  return result.rows.map((row) => Object.fromEntries(Object.entries(row)));
}

function normalizeParams(params = {}) {
  if (Array.isArray(params)) return params;
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key.startsWith("$") ? key : `$${key}`, value]),
  );
}

function normalizeSql(sql, params = {}) {
  if (Array.isArray(params)) return sql;
  return sql.replace(/@([A-Za-z_][A-Za-z0-9_]*)/g, "$$$1");
}

async function execute(sql, params = {}) {
  return db.execute({
    sql: normalizeSql(sql, params),
    args: normalizeParams(params),
  });
}

export async function initDb() {
  const schema = fs.readFileSync(path.resolve("db/schema.sql"), "utf8");
  const statements = schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await execute(statement);
  }
  const ingredientColumns = await all("PRAGMA table_info(ingredients)");
  if (!ingredientColumns.some((column) => column.name === "is_master")) {
    await execute("ALTER TABLE ingredients ADD COLUMN is_master INTEGER NOT NULL DEFAULT 0");
  }
  if (!ingredientColumns.some((column) => column.name === "ingredient_type")) {
    await execute("ALTER TABLE ingredients ADD COLUMN ingredient_type TEXT NOT NULL DEFAULT 'SB/Hijnx'");
  }
  const velocityColumns = await all("PRAGMA table_info(latest_velocity_rows)");
  if (!velocityColumns.some((column) => column.name === "projected_units")) {
    await execute("ALTER TABLE latest_velocity_rows ADD COLUMN projected_units REAL");
  }
}

export async function one(sql, params = {}) {
  const result = await execute(sql, params);
  return normalizeRows(result)[0];
}

export async function all(sql, params = {}) {
  const result = await execute(sql, params);
  return normalizeRows(result);
}

export async function run(sql, params = {}) {
  const result = await execute(sql, params);
  return {
    changes: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid ? Number(result.lastInsertRowid) : undefined,
  };
}

export async function execStatements(statements) {
  for (const statement of statements) {
    await run(statement.sql, statement.args || {});
  }
}

export async function upsertNamed(table, name, extra = {}) {
  const existing = await one(`SELECT id FROM ${table} WHERE name = ?`, [name]);
  if (existing) {
    const keys = Object.keys(extra);
    if (keys.length) {
      const sets = keys.map((key) => `${key} = @${key}`).join(", ");
      await run(`UPDATE ${table} SET ${sets} WHERE id = @id`, { id: existing.id, ...extra });
    }
    return existing.id;
  }
  const fields = ["name", ...Object.keys(extra)];
  const values = fields.map((field) => `@${field}`).join(", ");
  const info = await run(
    `INSERT INTO ${table} (${fields.join(", ")}) VALUES (${values})`,
    { name, ...extra },
  );
  return info.lastInsertRowid;
}

await initDb();

export async function ensureMasterProducts() {
  for (const product of MASTER_PRODUCTS) {
    const existing = await one("SELECT id FROM products WHERE name = ?", [product.name]);
    if (existing) {
      await run(
        "UPDATE products SET category = ?, active = 1 WHERE id = ?",
        [product.batchType, existing.id],
      );
    } else {
      await run(
        "INSERT INTO products (name, category, active) VALUES (?, ?, 1)",
        [product.name, product.batchType],
      );
    }
  }
  const existingSizeCount = (await one("SELECT COUNT(*) AS n FROM product_batch_sizes"))?.n || 0;
  if (!existingSizeCount) {
    for (const [name, batchSize] of STANDARD_BATCH_SIZES.entries()) {
      const product = await one("SELECT id FROM products WHERE name = ?", [name]);
      if (!product) continue;
      await run(
        "INSERT INTO product_batch_sizes (product_id, batch_size) VALUES (?, ?)",
        [product.id, batchSize],
      );
    }
  }
}

export async function ensureMasterIngredients() {
  for (const name of MASTER_INGREDIENTS) {
    const existing = await one("SELECT id FROM ingredients WHERE name = ?", [name]);
    const isEachIngredient = EACH_UOM_INGREDIENTS.has(name);
    if (existing) {
      await run(
        `UPDATE ingredients
         SET is_master = 1,
             purchase_uom = CASE
               WHEN ? = 1 THEN 'each'
               WHEN lower(COALESCE(purchase_uom, '')) = 'each' THEN 'each'
               WHEN lower(COALESCE(purchase_uom, '')) IN ('gram', 'grams') THEN 'grams'
               ELSE ?
             END,
             ingredient_type = CASE
               WHEN ingredient_type IN ('SB', 'Hijnx', 'SB/Hijnx') THEN ingredient_type
               ELSE 'SB/Hijnx'
             END,
             active = 1
         WHERE id = ?`,
        [isEachIngredient ? 1 : 0, isEachIngredient ? "each" : "grams", existing.id],
      );
    } else {
      await run(
        "INSERT INTO ingredients (name, purchase_uom, ingredient_type, is_master, active) VALUES (?, ?, 'SB/Hijnx', 1, 1)",
        [name, isEachIngredient ? "each" : "grams"],
      );
    }
  }
}

await ensureMasterProducts();
await ensureMasterIngredients();

for (const name of EACH_UOM_INGREDIENTS) {
  await run(`
    UPDATE product_formulas
    SET quantity_uom = 'each'
    WHERE source_sheet IS NULL
      AND ingredient_id IN (SELECT id FROM ingredients WHERE name = ?)
  `, [name]);
}
