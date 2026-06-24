import { all, db, one, run } from "./db.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function leadWeeks(days) {
  return Math.max(0, Math.ceil((Number(days) || 0) / 7));
}

function nearestWeekId(weekStart) {
  const exact = one("SELECT id FROM weeks WHERE week_start = ?", [weekStart]);
  if (exact) return exact.id;
  return one("SELECT id FROM weeks WHERE week_start <= ? ORDER BY week_start DESC LIMIT 1", [weekStart])?.id
    || one("SELECT id FROM weeks ORDER BY week_start ASC LIMIT 1")?.id;
}

export function calculateForecast() {
  const weeks = all("SELECT * FROM weeks ORDER BY week_start");
  const ingredients = all("SELECT * FROM ingredients WHERE active = 1 ORDER BY name");
  const usageRows = all(`
    SELECT pf.ingredient_id, pp.week_id, SUM(pp.planned_qty * COALESCE(pf.quantity_per_unit, 0)) AS required_usage
    FROM production_plan pp
    JOIN product_formulas pf ON pf.product_id = pp.product_id
    GROUP BY pf.ingredient_id, pp.week_id
  `);
  const receipts = all(`
    SELECT ingredient_id, week_id, SUM(quantity_received) AS quantity_received
    FROM received_inventory
    GROUP BY ingredient_id, week_id
  `);
  const usage = new Map(usageRows.map((r) => [`${r.ingredient_id}:${r.week_id}`, Number(r.required_usage) || 0]));
  const receiptMap = new Map(receipts.map((r) => [`${r.ingredient_id}:${r.week_id}`, Number(r.quantity_received) || 0]));
  const importedBalances = all("SELECT ingredient_id, week_id, beginning_qty FROM inventory_balances");
  const balanceMap = new Map(importedBalances.map((r) => [`${r.ingredient_id}:${r.week_id}`, Number(r.beginning_qty) || 0]));

  const output = [];
  const recs = [];

  for (const ingredient of ingredients) {
    let priorEnding = null;
    for (let i = 0; i < weeks.length; i += 1) {
      const week = weeks[i];
      const key = `${ingredient.id}:${week.id}`;
      const received = receiptMap.get(key) || 0;
      const requiredUsage = usage.get(key) || 0;
      const importedBeginning = balanceMap.get(key);
      const beginning = priorEnding === null
        ? (importedBeginning ?? 0) + received
        : priorEnding + received;
      const ending = beginning - requiredUsage;
      const threshold = Number(ingredient.reorder_threshold) || 0;
      const shortage = ending < threshold;
      output.push({
        ingredient_id: ingredient.id,
        ingredient_name: ingredient.name,
        week_id: week.id,
        week_start: week.week_start,
        beginning_qty: beginning,
        received_qty: received,
        required_usage: requiredUsage,
        ending_qty: ending,
        reorder_threshold: threshold,
        shortage,
        cost_per_unit: Number(ingredient.cost_per_unit) || 0,
        lead_time_days: Number(ingredient.lead_time_days) || 0,
      });

      if (shortage) {
        const recommendedQty = Math.max(threshold - ending, threshold || requiredUsage || 0);
        const orderIndex = Math.max(0, i - leadWeeks(ingredient.lead_time_days));
        recs.push({
          ingredient_id: ingredient.id,
          needed_week_id: week.id,
          order_week_id: weeks[orderIndex].id,
          recommended_qty: recommendedQty,
          projected_ending_qty: ending,
          estimated_cost: recommendedQty * (Number(ingredient.cost_per_unit) || 0),
          reason: ending < 0 ? "Projected shortage" : "Below reorder threshold",
        });
      }
      priorEnding = ending;
    }
  }

  return { weeks, ingredients, rows: output, recommendations: recs };
}

export function regenerateRecommendations() {
  const { recommendations } = calculateForecast();
  db.transaction(() => {
    run("DELETE FROM purchasing_recommendations");
    const insert = db.prepare(`
      INSERT INTO purchasing_recommendations
        (ingredient_id, needed_week_id, order_week_id, recommended_qty, projected_ending_qty, estimated_cost, reason)
      VALUES
        (@ingredient_id, @needed_week_id, @order_week_id, @recommended_qty, @projected_ending_qty, @estimated_cost, @reason)
    `);
    for (const rec of recommendations) insert.run(rec);
  })();
  return recommendations;
}

export function weekIdForDate(dateText) {
  const date = new Date(`${dateText}T00:00:00Z`);
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(date.getTime() + mondayOffset * MS_PER_DAY);
  return nearestWeekId(monday.toISOString().slice(0, 10));
}

export function expectedWeekFromLead(orderWeekStart, leadTimeDays) {
  return nearestWeekId(addDays(orderWeekStart, leadTimeDays || 0));
}
