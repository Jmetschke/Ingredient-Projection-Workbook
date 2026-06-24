import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import dotenv from "dotenv";

dotenv.config();

const dbPath = process.env.DATABASE_PATH || "./data/planning.db";
const resolvedPath = path.resolve(dbPath);
fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

export const db = new Database(resolvedPath);
db.pragma("foreign_keys = ON");

const schema = fs.readFileSync(path.resolve("db/schema.sql"), "utf8");
db.exec(schema);

export function one(sql, params = {}) {
  return db.prepare(sql).get(params);
}

export function all(sql, params = {}) {
  return db.prepare(sql).all(params);
}

export function run(sql, params = {}) {
  return db.prepare(sql).run(params);
}

export function tx(fn) {
  return db.transaction(fn)();
}

export function upsertNamed(table, name, extra = {}) {
  const existing = one(`SELECT id FROM ${table} WHERE name = ?`, [name]);
  if (existing) {
    const keys = Object.keys(extra);
    if (keys.length) {
      const sets = keys.map((key) => `${key} = @${key}`).join(", ");
      run(`UPDATE ${table} SET ${sets} WHERE id = @id`, { id: existing.id, ...extra });
    }
    return existing.id;
  }
  const fields = ["name", ...Object.keys(extra)];
  const values = fields.map((field) => `@${field}`).join(", ");
  const info = run(
    `INSERT INTO ${table} (${fields.join(", ")}) VALUES (${values})`,
    { name, ...extra },
  );
  return info.lastInsertRowid;
}
