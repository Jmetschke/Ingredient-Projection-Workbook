import { createClient } from "@libsql/client";

const calendarUrl = process.env.TURSO_CALENDAR_URL;
const calendarToken = process.env.TURSO_CALENDAR_TOKEN;

export const calendarDbConfigured = Boolean(calendarUrl && calendarToken);

export const calendarDb = calendarDbConfigured
  ? createClient({
      url: calendarUrl,
      authToken: calendarToken,
    })
  : null;

function normalizeRows(result) {
  return result.rows.map((row) => Object.fromEntries(Object.entries(row)));
}

export async function calendarAll(sql, params = []) {
  if (!calendarDb) {
    throw new Error("TURSO_CALENDAR_URL and TURSO_CALENDAR_TOKEN are not configured");
  }
  const result = await calendarDb.execute({ sql, args: params });
  return normalizeRows(result);
}

export async function calendarSchema() {
  if (!calendarDb) return [];
  const tables = await calendarAll(`
    SELECT name
    FROM sqlite_schema
    WHERE type IN ('table', 'view')
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_litestream_%'
    ORDER BY name
  `);
  const schema = [];
  for (const table of tables) {
    const columns = await calendarAll(`PRAGMA table_info("${String(table.name).replace(/"/g, '""')}")`);
    schema.push({
      name: table.name,
      columns: columns.map((column) => column.name),
    });
  }
  return schema;
}
