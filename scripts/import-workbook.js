import path from "node:path";
import XLSX from "xlsx";
import { db, one, run, tx, upsertNamed } from "../src/db.js";
import { regenerateRecommendations } from "../src/forecast.js";

const DEFAULT_WORKBOOK = "/Users/jhaskin/Downloads/Elevated Organics Production Planning Workbook v031225.xlsx";
const workbookPath = process.argv[2] || DEFAULT_WORKBOOK;

function cellAddress(row, col) {
  return XLSX.utils.encode_cell({ r: row - 1, c: col - 1 });
}

function getCell(sheet, row, col) {
  return sheet[cellAddress(row, col)];
}

function cellValue(sheet, row, col) {
  const cell = getCell(sheet, row, col);
  if (!cell) return null;
  if (cell.v === undefined || cell.v === null || cell.v === "") return null;
  return cell.v;
}

function cellFormula(sheet, row, col) {
  return getCell(sheet, row, col)?.f || null;
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function number(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const cleaned = String(value).replace(/[$,%\s,]/g, "");
  const match = cleaned.match(/-?\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function excelDate(serial) {
  if (!Number.isFinite(Number(serial)) || Number(serial) < 30000) return null;
  const utcDays = Number(serial) - 25569;
  const date = new Date(utcDays * 86400 * 1000);
  return date.toISOString().slice(0, 10);
}

function sheetRange(sheet) {
  return XLSX.utils.decode_range(sheet["!ref"] || "A1:A1");
}

function labelUom(label) {
  const match = text(label).match(/\(([^)]+)\)/);
  return match ? match[1].trim() : null;
}

function getWeekId(isoDate, serial = null) {
  if (!isoDate) return null;
  const found = one("SELECT id FROM weeks WHERE week_start = ?", [isoDate]);
  if (found) return found.id;
  return run(
    "INSERT INTO weeks (week_start, workbook_serial, label) VALUES (?, ?, ?)",
    [isoDate, serial, isoDate],
  ).lastInsertRowid;
}

function findProductId(name, extra = {}) {
  const clean = text(name);
  if (!clean) return null;
  return upsertNamed("products", clean, extra);
}

function findIngredientId(name, extra = {}) {
  const clean = text(name);
  if (!clean) return null;
  return upsertNamed("ingredients", clean, extra);
}

function clearImportedData() {
  const tables = [
    "purchasing_recommendations",
    "purchase_calendar_items",
    "velocity_assumptions",
    "received_inventory",
    "purchase_orders",
    "inventory_balances",
    "production_plan",
    "formula_tab_lines",
    "product_formulas",
    "ingredient_costs",
    "ingredients",
    "products",
    "suppliers",
    "weeks",
  ];
  for (const table of tables) run(`DELETE FROM ${table}`);
}

function importProductionPlan(wb) {
  const sheet = wb.Sheets["Production Plan"];
  if (!sheet) return { products: 0, planRows: 0, weeks: 0 };
  const range = sheetRange(sheet);
  const weekCols = [];
  for (let col = 2; col <= range.e.c + 1; col += 1) {
    const serial = number(cellValue(sheet, 5, col));
    const iso = excelDate(serial);
    if (iso) {
      weekCols.push({ col, serial, weekId: getWeekId(iso, serial), iso });
    }
  }

  let productCount = 0;
  let planRows = 0;
  for (let row = 6; row <= 38; row += 1) {
    const name = text(cellValue(sheet, row, 1));
    if (!name) continue;
    const productId = findProductId(name, {
      source_sheet: "Production Plan",
      source_row: row,
      category: "Production Schedule",
    });
    productCount += 1;
    for (const week of weekCols) {
      const qty = number(cellValue(sheet, row, week.col)) || 0;
      run(
        `INSERT INTO production_plan (product_id, week_id, planned_qty, source_sheet, source_cell)
         VALUES (?, ?, ?, 'Production Plan', ?)
         ON CONFLICT(product_id, week_id) DO UPDATE SET planned_qty = excluded.planned_qty`,
        [productId, week.weekId, qty, cellAddress(row, week.col)],
      );
      planRows += 1;
    }
  }
  return { products: productCount, planRows, weeks: weekCols.length };
}

function importIngredientPlan(wb) {
  const sheet = wb.Sheets["Ingredient Plan"];
  if (!sheet) return { ingredients: 0, formulas: 0 };
  const range = sheetRange(sheet);
  let ingredientCount = 0;
  let formulaCount = 0;

  for (let row = 1; row <= range.e.r + 1; row += 1) {
    const name = text(cellValue(sheet, row, 1));
    const next = text(cellValue(sheet, row + 1, 1));
    if (!name || !/^Purchase Unit of Measure/i.test(next)) continue;

    const purchaseUnitSize = number(cellValue(sheet, row + 1, 2));
    const purchaseUom = labelUom(next);
    const costPerPurchaseUom = number(cellValue(sheet, row + 2, 2));
    const costPerUnit = number(cellValue(sheet, row + 3, 2));
    const leadTimeDays = number(cellValue(sheet, row + 4, 2)) || 0;
    const reorderThreshold = number(cellValue(sheet, row + 5, 2)) || 0;
    const ingredientId = findIngredientId(name, {
      purchase_uom: purchaseUom,
      purchase_unit_size: purchaseUnitSize,
      cost_per_purchase_uom: costPerPurchaseUom,
      cost_per_unit: costPerUnit,
      lead_time_days: leadTimeDays,
      reorder_threshold: reorderThreshold,
      source_sheet: "Ingredient Plan",
      source_row: row,
    });
    ingredientCount += 1;
    if (costPerUnit !== null) {
      run(
        `INSERT INTO ingredient_costs
          (ingredient_id, cost_per_unit, cost_per_purchase_uom, source_sheet, source_cell)
         VALUES (?, ?, ?, 'Ingredient Plan', ?)`,
        [ingredientId, costPerUnit, costPerPurchaseUom, cellAddress(row + 3, 2)],
      );
    }

    const weekRow = row + 6;
    const weekCols = [];
    for (let col = 4; col <= range.e.c + 1; col += 1) {
      const serial = number(cellValue(sheet, weekRow, col));
      const iso = excelDate(serial);
      if (iso) weekCols.push({ col, weekId: getWeekId(iso, serial) });
    }

    let cursor = row + 7;
    let beginningRow = null;
    while (cursor <= range.e.r + 1) {
      const label = text(cellValue(sheet, cursor, 1));
      if (/^Beginning On-Hand Inventory$/i.test(label)) beginningRow = cursor;
      if (/^Ending On-Hand Inventory$/i.test(label)) break;
      cursor += 1;
    }
    const endingRow = cursor;
    const totalRow = endingRow + 1;
    const orderedRow = endingRow + 3;
    const receivedRow = endingRow + 4;

    if (beginningRow) {
      for (const week of weekCols) {
        const beginning = number(cellValue(sheet, beginningRow, week.col)) || 0;
        const ending = number(cellValue(sheet, endingRow, week.col)) || 0;
        run(
          `INSERT INTO inventory_balances
            (ingredient_id, week_id, beginning_qty, ending_qty, source_sheet, source_cell)
           VALUES (?, ?, ?, ?, 'Ingredient Plan', ?)
           ON CONFLICT(ingredient_id, week_id) DO UPDATE
             SET beginning_qty = excluded.beginning_qty, ending_qty = excluded.ending_qty`,
          [ingredientId, week.weekId, beginning, ending, cellAddress(beginningRow, week.col)],
        );
        const received = number(cellValue(sheet, receivedRow, week.col)) || 0;
        if (received) {
          run(
            `INSERT INTO received_inventory
              (ingredient_id, week_id, quantity_received, source_sheet, source_cell)
             VALUES (?, ?, ?, 'Ingredient Plan', ?)`,
            [ingredientId, week.weekId, received, cellAddress(receivedRow, week.col)],
          );
        }
        const ordered = number(cellValue(sheet, orderedRow, week.col)) || 0;
        if (ordered) {
          run(
            `INSERT INTO purchase_orders
              (ingredient_id, order_week_id, quantity_ordered, unit_cost, status, source_sheet, source_cell)
             VALUES (?, ?, ?, ?, 'planned', 'Ingredient Plan', ?)`,
            [ingredientId, week.weekId, ordered, costPerUnit || 0, cellAddress(orderedRow, week.col)],
          );
        }
      }
    }

    for (let productRow = row + 8; productRow < endingRow; productRow += 1) {
      const productName = text(cellValue(sheet, productRow, 1));
      if (!productName || /^total units used$/i.test(productName)) continue;
      const qtyPerUnit = number(cellValue(sheet, productRow, 2));
      const sourceFormula = cellFormula(sheet, productRow, 2);
      if (qtyPerUnit === null && !sourceFormula) continue;
      const productId = findProductId(productName);
      run(
        `INSERT OR IGNORE INTO product_formulas
          (product_id, ingredient_id, quantity_per_unit, quantity_uom, source_sheet, source_cell, source_formula)
         VALUES (?, ?, ?, ?, 'Ingredient Plan', ?, ?)`,
        [productId, ingredientId, qtyPerUnit || 0, purchaseUom, cellAddress(productRow, 2), sourceFormula],
      );
      formulaCount += 1;
    }

    row = Math.max(row, totalRow);
  }
  return { ingredients: ingredientCount, formulas: formulaCount };
}

function importVelocity(wb) {
  const sheet = wb.Sheets["velocity plan by week"];
  if (!sheet) return 0;
  const range = sheetRange(sheet);
  let count = 0;
  for (let row = 2; row <= range.e.r + 1; row += 1) {
    const itemName = text(cellValue(sheet, row, 1));
    if (!itemName) continue;
    const productId = findProductId(itemName, {
      source_sheet: "velocity plan by week",
      source_row: row,
      category: "Velocity Item",
    });
    run(
      `INSERT INTO velocity_assumptions
        (product_id, item_name, batch_size_after_waste, velocity_per_day, days_of_supply, weeks_of_supply, source_sheet, source_row)
       VALUES (?, ?, ?, ?, ?, ?, 'velocity plan by week', ?)`,
      [
        productId,
        itemName,
        number(cellValue(sheet, row, 2)),
        number(cellValue(sheet, row, 3)),
        number(cellValue(sheet, row, 4)),
        number(cellValue(sheet, row, 5)),
        row,
      ],
    );
    count += 1;
  }
  return count;
}

function importPurchaseCalendar(wb) {
  const sheet = wb.Sheets["Purchase Calander"];
  if (!sheet) return 0;
  const range = sheetRange(sheet);
  let count = 0;
  for (let row = 2; row <= range.e.r + 1; row += 2) {
    const serial = number(cellValue(sheet, row, 1));
    const weekId = getWeekId(excelDate(serial), serial);
    if (!weekId) continue;
    for (let col = 3; col <= range.e.c + 1; col += 1) {
      const item = text(cellValue(sheet, row, col));
      const qtyText = text(cellValue(sheet, row + 1, col));
      if (!item && !qtyText) continue;
      const ingredientId = item ? findIngredientId(item) : null;
      run(
        `INSERT INTO purchase_calendar_items
          (week_id, ingredient_id, item_name, quantity_text, quantity_value, source_sheet, source_cell)
         VALUES (?, ?, ?, ?, ?, 'Purchase Calander', ?)`,
        [weekId, ingredientId, item || "(blank item)", qtyText, number(qtyText), cellAddress(row, col)],
      );
      count += 1;
    }
  }
  return count;
}

function inferProductForFormulaSheet(sheetName) {
  const map = {
    "AM Pump": "Daytime Focus Micro Pump",
    "PM Pump": "Good Night Sleep Micro Pump",
    "P.Pouch": "Main Squeeze Party Pouch",
    "Whoopies 100": "RSO Whoopie Hi",
    Dots: "Micro Dots",
    MINIS: "Space Chunk Mini 10 Chunk (units)",
    "PECTIN - SINGLE ADDITIVE (2pk)": "Space Chunk SUGAR FREE 2pk (units)",
    "PECTIN - SINGLE ADDITIVE (10pk)": "Space Chunk SUGAR FREE 10pk (units)",
  };
  if (map[sheetName]) return map[sheetName];
  if (/OG|CBD|CBN|70_30|PECTIN/i.test(sheetName)) return sheetName.replace(/_/g, " ");
  return null;
}

function importFormulaTabs(wb) {
  const skip = new Set([
    "Purchase Calander",
    "velocity plan by week",
    "Production Plan",
    "Ingredient Plan",
    "Acctg - Purchg rollup",
    "Acctg - mtly cost rollup",
    "Acctg - Product costs summary",
    "Sheet1",
  ]);
  let count = 0;
  for (const sheetName of wb.SheetNames) {
    if (skip.has(sheetName)) continue;
    const sheet = wb.Sheets[sheetName];
    const range = sheetRange(sheet);
    const productName = inferProductForFormulaSheet(sheetName);
    const productId = productName ? findProductId(productName, { source_sheet: sheetName }) : null;

    for (let row = 1; row <= Math.min(range.e.r + 1, 120); row += 1) {
      const name = text(cellValue(sheet, row, 1)) || text(cellValue(sheet, row, 2));
      if (!name || /^(total|process|notes|customer|trade name|ingredient|formula calculator|only change|bright yellow|cells)$/i.test(name)) {
        continue;
      }
      const formulaQty = number(cellValue(sheet, row, 3));
      const percent = number(cellValue(sheet, row, 4)) ?? number(cellValue(sheet, row, 3));
      const batchQty = number(cellValue(sheet, row, 5));
      const hasQty = formulaQty !== null || batchQty !== null || cellFormula(sheet, row, 3) || cellFormula(sheet, row, 5);
      const ingredientish = /(oil|concentrate|isolate|extract|fluff|cookie|powder|sugar|water|flavor|color|puck|base|additive|gelatin|pectin|acid|distilate|distillate|meringe|mct|frosting|callets|chocolate)/i.test(name);
      if (!hasQty || !ingredientish) continue;
      run(
        `INSERT INTO formula_tab_lines
          (product_id, sheet_name, row_number, ingredient_name, formula_qty, formula_qty_formula,
           batch_qty, batch_qty_formula, percent_of_formula, percent_formula)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          productId,
          sheetName,
          row,
          name,
          formulaQty,
          cellFormula(sheet, row, 3),
          batchQty,
          cellFormula(sheet, row, 5),
          percent,
          cellFormula(sheet, row, 4),
        ],
      );
      count += 1;
    }
  }
  return count;
}

export function importWorkbook(filePath) {
  const resolved = path.resolve(filePath);
  const wb = XLSX.readFile(resolved, { cellFormula: true, cellNF: true, cellDates: false });
  return tx(() => {
    clearImportedData();
    const info = run("INSERT INTO imports (source_file, notes) VALUES (?, ?)", [
      resolved,
      `Imported sheets: ${wb.SheetNames.join(", ")}`,
    ]);
    const production = importProductionPlan(wb);
    const ingredients = importIngredientPlan(wb);
    const velocity = importVelocity(wb);
    const purchaseCalendar = importPurchaseCalendar(wb);
    const formulaLines = importFormulaTabs(wb);
    const recommendations = regenerateRecommendations().length;
    return {
      importId: info.lastInsertRowid,
      source: resolved,
      sheets: wb.SheetNames,
      production,
      ingredients,
      velocity,
      purchaseCalendar,
      formulaLines,
      recommendations,
    };
  });
}

if (process.argv[1] && import.meta.url.endsWith(`/${process.argv[1].split("/").pop()}`)) {
  const result = importWorkbook(workbookPath);
  console.log(JSON.stringify(result, null, 2));
}
