import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import dotenv from "dotenv";
import express from "express";
import PDFDocument from "pdfkit";
import XLSX from "xlsx";
import { all, one, run, withTransaction } from "./src/db.js";
import { calendarAll, calendarDbConfigured, calendarSchema } from "./src/rl-calendar-db.js";
import { BATCH_TYPES, PRODUCT_ALIASES, VELOCITY_BATCH_UNIT_MULTIPLIERS } from "./src/master-products.js";
import { bomUomForIngredient } from "./src/master-ingredients.js";
import { INGREDIENT_UNIT_CONVERSION_BY_NAME } from "./src/ingredient-unit-conversions.js";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3000);
const INGREDIENT_TYPES = new Set(["SB", "Hijnx", "SB/Hijnx"]);
let calendarSchemaCache = { expiresAt: 0, schema: null };
let forwardWeeksEnsuredKey = "";
let forwardWeeksEnsurePromise = null;

app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  if (["/", "/index.html", "/app.js", "/styles.css", "/service-worker.js", "/app-version.json"].includes(req.path)) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  }
  next();
});
app.use(express.static(path.resolve("public")));

function ok(res, data) {
  res.json({ ok: true, data });
}

function withBomUom(row) {
  if (!row) return row;
  const storedUom = String(row.purchase_uom || "").toLowerCase();
  const bomUom = storedUom === "each" ? "each" : storedUom === "grams" ? "grams" : bomUomForIngredient(row.name);
  return { ...row, bom_uom: bomUom, purchase_uom: bomUom, ingredient_type: normalizeIngredientType(row.ingredient_type) };
}

function normalizeIngredientUom(value, name = "") {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "each") return "each";
  if (raw === "gram" || raw === "grams") return "grams";
  return bomUomForIngredient(name);
}

function normalizeIngredientType(value) {
  const raw = String(value || "").trim();
  return INGREDIENT_TYPES.has(raw) ? raw : "SB/Hijnx";
}

function normalizeMatchText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\bchrush\b/g, "crush")
    .replace(/\bstarwberry\b/g, "strawberry")
    .replace(/\bpomegrante\b/g, "pomegranate")
    .replace(/\bpassionfruit\b/g, "passion fruit")
    .replace(/\bdragonfruit\b/g, "dragon fruit")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(oz|g|gram|grams|unit|units|pcs|piece|pieces|pack|packs)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pdfText(value = "") {
  return value
    .replace(/\\([()\\])/g, "$1")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .trim();
}

function pdfNumber(value) {
  const match = String(value || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function extractPdfTextItems(buffer) {
  const lines = buffer.toString("latin1").split(/\r?\n/);
  const items = [];
  let currentX = 0;
  let currentY = 0;
  let lastY = 0;
  let page = 0;
  let sawRowText = false;
  for (const line of lines) {
    const td = line.match(/^\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+Td\s*$/);
    if (td) {
      currentX = Number(td[1]);
      currentY = Number(td[2]);
      if (sawRowText && currentY > lastY + 80) page += 1;
      lastY = currentY;
      continue;
    }
    const text = line.match(/^\s*\((.*)\)\s*Tj\s*$/);
    const continuedText = line.match(/^\s*T\*\s*\((.*)\)\s*Tj\s*$/);
    if (!text && !continuedText) continue;
    const value = pdfText((text || continuedText)[1]);
    if (!value) continue;
    sawRowText = true;
    items.push({ page, x: currentX, y: currentY, text: value });
  }
  return items;
}

function rowsFromVelocityPdf(buffer) {
  const grouped = new Map();
  for (const item of extractPdfTextItems(buffer)) {
    const key = `${item.page}:${Math.round(item.y)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return Array.from(grouped.values()).map((items) => {
    const status = items
      .filter((item) => item.x >= 39 && item.x < 88)
      .map((item) => item.text)
      .join(" ")
      .trim();
    const sku = items
      .filter((item) => item.x >= 85 && item.x < 213)
      .sort((a, b) => a.x - b.x)
      .map((item) => item.text)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const velocityText = items
      .filter((item) => item.x >= 439 && item.x < 485)
      .map((item) => item.text)
      .join(" ");
    const projectedText = items
      .filter((item) => item.x >= 326 && item.x < 383)
      .map((item) => item.text)
      .join(" ");
    const velocityPerDay = pdfNumber(velocityText);
    const projectedUnits = pdfNumber(projectedText);
    return { status, sku, projected_units: projectedUnits, velocity_per_day: velocityPerDay };
  }).filter((row) => /^(OK|CRITICAL|BELOW PAR)$/i.test(row.status) && row.sku && Number.isFinite(row.velocity_per_day));
}

function inflatePdfStreams(buffer) {
  const source = buffer.toString("latin1");
  const streams = [];
  const streamRe = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;
  while ((match = streamRe.exec(source))) {
    try {
      streams.push(zlib.inflateSync(Buffer.from(match[1], "latin1")).toString("latin1"));
    } catch {
      // Non-Flate streams are not useful for this text extraction pass.
    }
  }
  return streams;
}

function inflatePdfObject(buffer, objectId) {
  const source = buffer.toString("latin1");
  const start = source.indexOf(`${objectId} 0 obj`);
  if (start < 0) return "";
  const end = source.indexOf("endobj", start);
  const body = source.slice(start, end < 0 ? undefined : end);
  const stream = body.match(/stream\r?\n([\s\S]*?)\r?\nendstream/);
  if (!stream) return "";
  try {
    return zlib.inflateSync(Buffer.from(stream[1], "latin1")).toString("latin1");
  } catch {
    return "";
  }
}

function pdfCMap(buffer, objectId) {
  const text = inflatePdfObject(buffer, objectId);
  const map = new Map();
  let block;
  const charBlocks = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((block = charBlocks.exec(text))) {
    const rowRe = /<([0-9A-F]+)>\s*<([0-9A-F]+)>/g;
    let row;
    while ((row = rowRe.exec(block[1]))) {
      map.set(row[1].toUpperCase(), String.fromCodePoint(parseInt(row[2].slice(-4), 16)));
    }
  }
  const rangeBlocks = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((block = rangeBlocks.exec(text))) {
    const rowRe = /<([0-9A-F]+)>\s*<([0-9A-F]+)>\s*<([0-9A-F]+)>/g;
    let row;
    while ((row = rowRe.exec(block[1]))) {
      const first = parseInt(row[1], 16);
      const last = parseInt(row[2], 16);
      const unicodeStart = parseInt(row[3], 16);
      const length = row[1].length;
      for (let value = first; value <= last && value - first < 1000; value += 1) {
        map.set(
          value.toString(16).toUpperCase().padStart(length, "0"),
          String.fromCodePoint(unicodeStart + value - first),
        );
      }
    }
  }
  return map;
}

function distruFontMaps(buffer) {
  const source = buffer.toString("latin1");
  const dynamicMapIds = [];
  const toUnicodeRe = /\/ToUnicode\s+(\d+)\s+0\s+R/g;
  let match;
  while ((match = toUnicodeRe.exec(source))) {
    const objectId = Number(match[1]);
    if (!dynamicMapIds.includes(objectId)) dynamicMapIds.push(objectId);
  }
  // Distru valuation PDFs rendered by Chromium/Skia use F4-F9 for the visible table.
  // The ToUnicode object ids change between exports, so discover them dynamically.
  const fontNames = ["F4", "F5", "F6", "F7", "F8", "F9"];
  const candidateMaps = dynamicMapIds.length >= fontNames.length
    ? Object.fromEntries(fontNames.map((font, index) => [font, dynamicMapIds[index]]))
    : { F4: 1705, F5: 1722, F6: 1741, F7: 1753, F8: 1793, F9: 1862 };
  return new Map(
    Object.entries(candidateMaps)
      .map(([font, objectId]) => [font, pdfCMap(buffer, objectId)])
      .filter(([, map]) => map.size),
  );
}

function decodePdfHexText(hex, font, fontMaps) {
  const map = fontMaps.get(font);
  if (!map) return "";
  const lengths = [...new Set([...map.keys()].map((key) => key.length))].sort((a, b) => b - a);
  let output = "";
  for (let index = 0; index < hex.length;) {
    let matched = false;
    for (const length of lengths) {
      const code = hex.slice(index, index + length).toUpperCase();
      if (map.has(code)) {
        output += map.get(code);
        index += length;
        matched = true;
        break;
      }
    }
    if (!matched) index += 2;
  }
  return output;
}

function extractDistruInventoryTextItems(buffer) {
  const fontMaps = distruFontMaps(buffer);
  const items = [];
  let page = 0;
  for (const stream of inflatePdfStreams(buffer)) {
    if (!stream.includes("BT")) continue;
    page += 1;
    let font = "";
    let x = 0;
    let y = 0;
    const tokenRe = /(BT|ET)|\/(F\d+)\s+[\d.]+\s+Tf|1\s+0\s+0\s+-1\s+([\d.\-]+)\s+([\d.\-]+)\s+Tm|([\d.\-]+)\s+([\d.\-]+)\s+Td|<([0-9A-F]+)>\s+Tj/g;
    let token;
    while ((token = tokenRe.exec(stream))) {
      if (token[2]) font = token[2];
      else if (token[3]) {
        x = Number(token[3]);
        y = Number(token[4]);
      } else if (token[5]) {
        x += Number(token[5]);
        y += Number(token[6]);
      } else if (token[7]) {
        const text = decodePdfHexText(token[7], font, fontMaps);
        if (text) items.push({ page, x, y, text });
      }
    }
  }
  return items;
}

function cleanPdfCell(value) {
  return String(value || "").replace(/[\b\f]/g, " ").replace(/\s+/g, " ").trim();
}

function pdfColumnNumber(items, minX, maxX = Infinity) {
  const raw = items
    .filter((item) => item.x >= minX && item.x < maxX)
    .sort((a, b) => a.x - b.x)
    .map((item) => item.text)
    .join("")
    .replace(/[^\d.\-]/g, "");
  if (!/\d/.test(raw)) return null;
  const number = Number(raw);
  return Number.isFinite(number) ? number : null;
}

function guessInventoryUom(name) {
  return normalizeIngredientUom("", name);
}

function inventoryConversionForName(name) {
  return INGREDIENT_UNIT_CONVERSION_BY_NAME.get(String(name || "").trim().toLowerCase()) || null;
}

function withInventoryConversion(row, matchedName = "") {
  const conversion = inventoryConversionForName(matchedName) || inventoryConversionForName(row.uploaded_name);
  const gramsPerInventoryUnit = Number(conversion?.grams_per_inventory_unit);
  const hasGramConversion = Number.isFinite(gramsPerInventoryUnit) && gramsPerInventoryUnit > 0;
  const eachPerInventoryUnit = Number(conversion?.each_per_inventory_unit);
  const hasEachConversion = Number.isFinite(eachPerInventoryUnit) && eachPerInventoryUnit > 0;
  const alreadyConvertedEach = hasEachConversion
    && row.inventory_uom === conversion?.inventory_uom
    && String(row.quantity_uom || "").toLowerCase() === "each";
  return {
    ...row,
    current_qty: hasEachConversion && !alreadyConvertedEach
      ? Number(row.current_qty || 0) * eachPerInventoryUnit
      : row.current_qty,
    quantity_uom: hasEachConversion ? "each" : row.quantity_uom,
    inventory_uom: conversion?.inventory_uom || row.inventory_uom || row.quantity_uom || guessInventoryUom(row.uploaded_name),
    grams_per_inventory_unit: hasGramConversion ? gramsPerInventoryUnit : null,
    current_qty_grams: hasGramConversion ? Number(row.current_qty || 0) * gramsPerInventoryUnit : null,
  };
}

function rowsFromDistruInventoryPdf(buffer) {
  const finishedGoodBrands = new Set(["hijnx", "snackbar", "pheotera"]);
  const finishedGoodNamePattern = /^(hijnx|snackbar|pheotera)\s+(edible|beverage|tincture|1g vapes|2g vapes)?\s*\|/i;
  const grouped = new Map();
  for (const item of extractDistruInventoryTextItems(buffer)) {
    const key = `${item.page}:${Math.round(item.y)}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  const lineRows = [...grouped.values()].map((items) => {
    const sorted = items.sort((a, b) => a.x - b.x);
    const uploadedName = cleanPdfCell(sorted.filter((item) => item.x < 220).map((item) => item.text).join(""));
    // Distru includes finished-good/METRC rows when "Exclude METRC items" is off.
    // Those rows are identified by the Brand column; ingredient/package rows leave it blank.
    const brand = cleanPdfCell(sorted.filter((item) => item.x >= 340 && item.x < 405).map((item) => item.text).join(""));
    // The valuation report has Available around x=484 and On Hand around x=650.
    // Current Inventory uses On Hand when present and falls back to Available.
    const onHand = pdfColumnNumber(sorted, 640, 700);
    const available = pdfColumnNumber(sorted, 475, 535);
    const currentQty = onHand ?? available;
    return {
      page: sorted[0]?.page || 0,
      y: sorted[0]?.y || 0,
      uploaded_name: uploadedName,
      brand,
      current_qty: currentQty,
      quantity_uom: guessInventoryUom(uploadedName),
    };
  }).sort((a, b) => a.page - b.page || a.y - b.y);
  const consumed = new Set();
  const mergedRows = lineRows.map((row, index) => {
    if (consumed.has(index) || Number.isFinite(row.current_qty)) return row;
    const nearbyRows = lineRows
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(({ candidate, candidateIndex }) => (
        candidateIndex > index
        && candidate.page === row.page
        && candidate.y - row.y > 0
        && candidate.y - row.y <= 18
      ));
    const quantityRow = nearbyRows.find(({ candidate }) => !candidate.uploaded_name && Number.isFinite(candidate.current_qty));
    if (!quantityRow) return row;
    const continuationNames = nearbyRows
      .filter(({ candidate }) => candidate.uploaded_name && !Number.isFinite(candidate.current_qty))
      .map(({ candidate, candidateIndex }) => {
        consumed.add(candidateIndex);
        return candidate.uploaded_name;
      });
    consumed.add(quantityRow.candidateIndex);
    const mergedName = cleanPdfCell([row.uploaded_name, ...continuationNames].join(" "));
    return {
      ...row,
      uploaded_name: mergedName,
      current_qty: quantityRow.candidate.current_qty,
      quantity_uom: guessInventoryUom(mergedName),
    };
  }).filter((_, index) => !consumed.has(index));
  return mergedRows.filter((row) => {
    const normalizedName = normalizeMatchText(row.uploaded_name);
    const normalizedBrand = normalizeMatchText(row.brand);
    return row.uploaded_name
      && Number.isFinite(row.current_qty)
      && !finishedGoodBrands.has(normalizedBrand)
      && !finishedGoodNamePattern.test(row.uploaded_name)
      && !["name", "total"].includes(normalizedName)
      && !(normalizedName.split(" ").length <= 1 && Number(row.current_qty || 0) === 0)
      && normalizedName.length > 2;
  }).map(({ page, y, brand, ...row }) => {
    return row;
  });
}

function scoreProductMatch(uploadName, productName) {
  const upload = normalizeMatchText(uploadName);
  const product = normalizeMatchText(productName);
  if (!upload || !product) return 0;
  if (upload === product) return 1;
  if (product.includes(upload) || upload.includes(product)) return 0.92;
  const uploadTokens = new Set(upload.split(" ").filter(Boolean));
  const productTokens = new Set(product.split(" ").filter(Boolean));
  const intersection = [...uploadTokens].filter((token) => productTokens.has(token)).length;
  const union = new Set([...uploadTokens, ...productTokens]).size || 1;
  return intersection / union;
}

function scoreIngredientMatch(uploadName, ingredientName) {
  const upload = normalizeMatchText(uploadName);
  const ingredient = normalizeMatchText(ingredientName);
  if (!upload || !ingredient) return 0;
  if (upload === ingredient) return 1;
  if (upload.split(" ").length <= 1) return 0;
  if (ingredient.includes(upload) || upload.includes(ingredient)) return 0.94;
  const uploadTokens = new Set(upload.split(" ").filter(Boolean));
  const ingredientTokens = new Set(ingredient.split(" ").filter(Boolean));
  const intersection = [...uploadTokens].filter((token) => ingredientTokens.has(token)).length;
  const union = new Set([...uploadTokens, ...ingredientTokens]).size || 1;
  return intersection / union;
}

function matchInventoryRows(rows, ingredients) {
  return rows.map((row) => {
    const scored = ingredients
      .map((ingredient) => ({ ingredient, score: scoreIngredientMatch(row.uploaded_name, ingredient.name) }))
      .sort((a, b) => b.score - a.score)[0];
    const match = scored?.score >= 0.5 ? scored : null;
    const matchedRow = {
      ...row,
      ingredient_id: match?.ingredient.id || null,
      ingredient_name: match?.ingredient.name || "",
      ingredient_type: normalizeIngredientType(match?.ingredient.ingredient_type),
      match_score: Number((match?.score || 0).toFixed(3)),
      match_method: match ? (match.score === 1 ? "exact" : "fuzzy") : "unmatched",
      quantity_uom: match?.ingredient.purchase_uom || row.quantity_uom || guessInventoryUom(row.uploaded_name),
    };
    return withInventoryConversion(matchedRow, match?.ingredient.name);
  });
}

function matchVelocityRows(rows, products) {
  const productByName = new Map(products.map((product) => [product.name, product]));
  return rows.map((row) => {
    const aliasTarget = PRODUCT_ALIASES.get(row.sku);
    const aliasProduct = aliasTarget ? productByName.get(aliasTarget) : null;
    const scored = products
      .map((product) => ({ product, score: scoreProductMatch(row.sku, product.name) }))
      .sort((a, b) => b.score - a.score)[0];
    const match = aliasProduct
      ? { product: aliasProduct, score: 1, method: "alias" }
      : { product: scored?.score >= 0.35 ? scored.product : null, score: scored?.score || 0, method: scored?.score === 1 ? "exact" : "fuzzy" };
    return {
      uploaded_name: row.sku,
      projected_units: row.projected_units,
      velocity_per_day: row.velocity_per_day,
      product_id: match.product?.id || null,
      product_name: match.product?.name || "",
      batch_type: match.product?.category || "",
      match_score: Number(match.score.toFixed(3)),
      match_method: match.product ? match.method : "unmatched",
    };
  });
}

async function latestVelocityRows() {
  return all(`
    SELECT uploaded_name,
           projected_units,
           velocity_per_day,
           product_id,
           product_name,
           batch_type,
           match_score,
           match_method,
           uploaded_at
    FROM latest_velocity_rows
    ORDER BY id
  `);
}

async function latestInventoryRows() {
  const rows = await all(`
    SELECT id,
           uploaded_name,
           current_qty,
           quantity_uom,
           inventory_uom,
           grams_per_inventory_unit,
           current_qty_grams,
           ingredient_id,
           ingredient_name,
           ingredient_type,
           match_score,
           match_method,
           uploaded_at
    FROM latest_inventory_rows
    ORDER BY uploaded_name
  `);
  return rows.map((row) => (
    row.current_qty_grams == null && row.ingredient_name
      ? withInventoryConversion(row, row.ingredient_name)
      : row
  ));
}

async function activeMasterIngredients() {
  const rows = await all(`
    SELECT id, name, purchase_uom, ingredient_type
    FROM ingredients
    WHERE is_master = 1 AND active = 1
    ORDER BY name
  `);
  return rows.map(withBomUom);
}

async function replaceLatestInventoryRows(rows) {
  await run("DELETE FROM latest_inventory_rows");
  for (const row of rows) {
    await run(
      `INSERT INTO latest_inventory_rows
        (uploaded_name, current_qty, quantity_uom, inventory_uom, grams_per_inventory_unit, current_qty_grams,
         ingredient_id, ingredient_name, ingredient_type, match_score, match_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.uploaded_name,
        row.current_qty ?? 0,
        row.quantity_uom || guessInventoryUom(row.uploaded_name),
        row.inventory_uom || row.quantity_uom || guessInventoryUom(row.uploaded_name),
        row.grams_per_inventory_unit ?? null,
        row.current_qty_grams ?? null,
        row.ingredient_id || null,
        row.ingredient_name || "",
        normalizeIngredientType(row.ingredient_type),
        row.match_score ?? null,
        row.match_method || "unmatched",
      ],
    );
  }
}

async function rematchLatestInventoryRows() {
  const rawRows = (await latestInventoryRows()).map((row) => ({
    uploaded_name: row.uploaded_name,
    current_qty: row.current_qty,
    quantity_uom: row.quantity_uom || guessInventoryUom(row.uploaded_name),
    inventory_uom: row.inventory_uom || row.quantity_uom || guessInventoryUom(row.uploaded_name),
  }));
  const matched = matchInventoryRows(rawRows, await activeMasterIngredients());
  await replaceLatestInventoryRows(matched);
  return latestInventoryRows();
}

function withVelocityBatchYield(product) {
  const batchSize = Number(product.batch_size || 0);
  const multiplier = VELOCITY_BATCH_UNIT_MULTIPLIERS.get(product.name) || 1;
  return {
    ...product,
    velocity_batch_multiplier: multiplier,
    velocity_units_per_batch: batchSize > 0 ? batchSize * multiplier : null,
  };
}

async function replaceLatestVelocityRows(rows) {
  await run("DELETE FROM latest_velocity_rows");
  for (const row of rows) {
    await run(
      `INSERT INTO latest_velocity_rows
        (uploaded_name, projected_units, velocity_per_day, product_id, product_name, batch_type, match_score, match_method)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.uploaded_name,
        row.projected_units ?? null,
        row.velocity_per_day,
        row.product_id || null,
        row.product_name || "",
        row.batch_type || "",
        row.match_score ?? null,
        row.match_method || "",
      ],
    );
  }
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

function nextProductionWeekStart(date = new Date()) {
  return addDateDays(mondayForDate(date), 7);
}

function sundayForDate(date = new Date()) {
  return addDateDays(date, -date.getDay());
}

function dateWindowFromQuery(query = {}, days = 42) {
  const isoPattern = /^\d{4}-\d{2}-\d{2}$/;
  const start = isoPattern.test(String(query.start || "")) ? String(query.start) : localIsoDate(sundayForDate(new Date()));
  const end = isoPattern.test(String(query.end || "")) ? String(query.end) : localIsoDate(addDateDays(new Date(`${start}T00:00:00`), days - 1));
  return { start, end };
}

async function cachedCalendarSchema() {
  const now = Date.now();
  if (calendarSchemaCache.schema && calendarSchemaCache.expiresAt > now) {
    return calendarSchemaCache.schema;
  }
  const schema = await calendarSchema();
  calendarSchemaCache = { schema, expiresAt: now + 5 * 60 * 1000 };
  return schema;
}

async function ensureForwardWeeks(count = 78) {
  const start = mondayForDate(new Date());
  const key = `${localIsoDate(start)}:${count}`;
  if (forwardWeeksEnsuredKey === key) return;
  if (forwardWeeksEnsurePromise) {
    await forwardWeeksEnsurePromise;
    if (forwardWeeksEnsuredKey === key) return;
  }
  forwardWeeksEnsurePromise = (async () => {
    for (let index = 0; index < count; index += 1) {
      const weekStart = localIsoDate(addDateDays(start, index * 7));
      await run(
        `INSERT INTO weeks (week_start, label)
         VALUES (?, ?)
         ON CONFLICT(week_start) DO NOTHING`,
        [weekStart, weekStart],
      );
    }
    forwardWeeksEnsuredKey = key;
  })();
  try {
    await forwardWeeksEnsurePromise;
  } finally {
    forwardWeeksEnsurePromise = null;
  }
}

function productionIngredientFilters(query) {
  const where = ["pb.quantity > 0"];
  const params = {};
  if (query.batch_type && BATCH_TYPES.includes(query.batch_type)) {
    where.push("pb.batch_type = @batchType");
    params.batchType = query.batch_type;
  }
  params.start = query.start || localIsoDate(nextProductionWeekStart());
  where.push("w.week_start >= @start");
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
      start: params.start,
      end: query.end || "",
    },
    rows,
    detail,
  };
}

function forecastDateWindowWeeks(weeks = 26) {
  const start = nextProductionWeekStart(new Date());
  const weekCount = Number.isFinite(Number(weeks)) && Number(weeks) > 0 ? Math.round(Number(weeks)) : 26;
  const end = addDateDays(start, weekCount * 7 - 1);
  return {
    start: localIsoDate(start),
    end: localIsoDate(end),
  };
}

function forecastDateWindow(query = {}) {
  const legacyMonthWeeks = { 1: 4, 3: 13, 6: 26, 9: 39, 12: 52 };
  const requestedWeeks = Number(query.weeks);
  const weekCount = Number.isFinite(requestedWeeks) && requestedWeeks > 0
    ? Math.round(requestedWeeks)
    : legacyMonthWeeks[Number(query.months)] || 26;
  const isoPattern = /^\d{4}-\d{2}-\d{2}$/;
  const defaultWindow = forecastDateWindowWeeks(weekCount);
  const start = isoPattern.test(String(query.start || "")) ? String(query.start) : defaultWindow.start;
  let end = isoPattern.test(String(query.end || "")) ? String(query.end) : "";
  if (!end || end < start) {
    end = localIsoDate(addDateDays(new Date(`${start}T00:00:00`), weekCount * 7 - 1));
  }
  const days = Math.max(1, Math.round((new Date(`${end}T00:00:00`) - new Date(`${start}T00:00:00`)) / (24 * 60 * 60 * 1000)) + 1);
  return {
    weeks: Math.max(1, Math.ceil(days / 7)),
    start,
    end,
    baselineStart: defaultWindow.start,
  };
}

async function scheduledIngredientUsageForecast(query = {}) {
  const { weeks: weekCount, start, end, baselineStart } = forecastDateWindow(query);
  const rows = await all(`
    SELECT i.id AS ingredient_id,
           i.name AS ingredient_name,
           i.ingredient_type,
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
      AND w.week_start <= @end
    GROUP BY i.id, i.ingredient_type, COALESCE(pf.quantity_uom, 'grams')
    HAVING required_qty > 0
    ORDER BY i.name, quantity_uom
  `, { start, end });
  const priorRows = baselineStart < start ? await all(`
    SELECT i.id AS ingredient_id,
           COALESCE(pf.quantity_uom, 'grams') AS quantity_uom,
           SUM(pb.quantity * COALESCE(pf.quantity_per_unit, 0)) AS prior_required_qty
    FROM production_batches pb
    JOIN weeks w ON w.id = pb.week_id
    JOIN product_formulas pf ON pf.product_id = pb.product_id AND pf.source_sheet IS NULL
    JOIN ingredients i ON i.id = pf.ingredient_id
    WHERE pb.quantity > 0
      AND w.week_start >= @baselineStart
      AND w.week_start < @start
    GROUP BY i.id, COALESCE(pf.quantity_uom, 'grams')
  `, { baselineStart, start }) : [];
  const priorUsageByKey = new Map(priorRows.map((row) => [
    `${row.ingredient_id}:${String(row.quantity_uom || "").toLowerCase()}`,
    Number(row.prior_required_qty || 0),
  ]));
  const inventoryRows = await latestInventoryRows();
  const inventoryByIngredient = new Map();
  const inventoryByName = new Map();
  function addInventoryAggregate(map, key, row) {
    if (!key) return;
    const existing = map.get(key);
    const gramQty = row.current_qty_grams == null ? null : Number(row.current_qty_grams || 0);
    if (existing) {
      existing.current_qty += Number(row.current_qty || 0);
      existing.current_qty_grams = existing.current_qty_grams == null || gramQty == null
        ? null
        : existing.current_qty_grams + gramQty;
    } else {
      map.set(key, {
        ...row,
        current_qty: Number(row.current_qty || 0),
        current_qty_grams: gramQty,
      });
    }
  }
  for (const row of inventoryRows) {
    addInventoryAggregate(inventoryByIngredient, row.ingredient_id ? String(row.ingredient_id) : "", row);
    addInventoryAggregate(inventoryByName, normalizeMatchText(row.ingredient_name || row.uploaded_name), row);
  }
  function rowWithInventory(row, inventory) {
    const rowUom = String(row.quantity_uom || inventory?.quantity_uom || "").toLowerCase();
    const isEach = rowUom === "each";
    const currentInventoryValue = isEach
      ? inventory?.current_qty ?? null
      : inventory?.current_qty_grams ?? inventory?.current_qty ?? null;
    const currentInventoryGrams = isEach
      ? inventory?.current_qty ?? null
      : inventory?.current_qty_grams ?? inventory?.current_qty ?? null;
    const priorUsage = priorUsageByKey.get(`${row.ingredient_id}:${rowUom}`) || 0;
    const startingInventoryValue = currentInventoryValue == null
      ? null
      : Math.max(0, Number(currentInventoryValue || 0) - priorUsage);
    const requiredQty = Number(row.required_qty || 0);
    const projectedRemainingQty = startingInventoryValue == null
      ? null
      : startingInventoryValue - requiredQty;
    const neededToOrderQty = projectedRemainingQty == null
      ? null
      : Math.max(0, -projectedRemainingQty);
    const conversion = inventoryConversionForName(row.ingredient_name)
      || inventoryConversionForName(inventory?.uploaded_name);
    const unitsPerOrderUnit = rowUom === "each"
      ? Number(conversion?.each_per_inventory_unit)
      : Number(inventory?.grams_per_inventory_unit ?? conversion?.grams_per_inventory_unit);
    const hasOrderConversion = Number.isFinite(unitsPerOrderUnit) && unitsPerOrderUnit > 0;
    return {
      ...row,
      quantity_uom: row.quantity_uom || inventory?.quantity_uom || "grams",
      current_inventory: inventory ? inventory.current_qty : null,
      current_inventory_grams: currentInventoryGrams,
      current_inventory_value: currentInventoryValue,
      prior_usage_qty: priorUsage,
      starting_inventory_value: startingInventoryValue,
      projected_remaining_qty: projectedRemainingQty,
      needed_to_order_qty: neededToOrderQty,
      order_units_needed: neededToOrderQty == null || !hasOrderConversion
        ? null
        : Math.ceil(neededToOrderQty / unitsPerOrderUnit),
      order_unit_uom: conversion?.inventory_uom || inventory?.inventory_uom || "",
      current_inventory_uom: isEach ? "each" : "grams",
      inventory_uom: inventory?.quantity_uom || row.quantity_uom,
      inventory_source_uom: inventory?.inventory_uom || "",
      grams_per_inventory_unit: inventory?.grams_per_inventory_unit ?? null,
      inventory_uploaded_name: inventory?.uploaded_name || "",
    };
  }
  const rowKeys = new Set();
  const rowsWithInventory = rows.map((row) => {
    const inventory = inventoryByIngredient.get(String(row.ingredient_id))
      || inventoryByName.get(normalizeMatchText(row.ingredient_name));
    rowKeys.add(`${row.ingredient_id}:${String(row.quantity_uom || "").toLowerCase()}`);
    return rowWithInventory(row, inventory);
  });
  for (const inventory of inventoryByIngredient.values()) {
    if (!inventory.ingredient_id) continue;
    const inventoryUom = String(inventory.quantity_uom || "").toLowerCase();
    const key = `${inventory.ingredient_id}:${inventoryUom}`;
    if (rowKeys.has(key)) continue;
    rowKeys.add(key);
    rowsWithInventory.push(rowWithInventory({
      ingredient_id: inventory.ingredient_id,
      ingredient_name: inventory.ingredient_name || inventory.uploaded_name,
      ingredient_type: normalizeIngredientType(inventory.ingredient_type),
      quantity_uom: inventory.quantity_uom || "grams",
      required_qty: 0,
      scheduled_batches: 0,
      product_count: 0,
      products: "",
      first_week: "",
      last_week: "",
    }, inventory));
  }
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
      AND w.week_start <= @end
    ORDER BY w.week_start, i.name, p.name
  `, { start, end });
  return {
    filters: { weeks: weekCount, start, end, baseline_start: baselineStart },
    rows: rowsWithInventory,
    detail,
    inventoryRows,
    unmatchedInventoryRows: inventoryRows.filter((row) => !row.ingredient_id),
  };
}

function forecastInventoryValue(row) {
  if (row.starting_inventory_value != null) return Number(row.starting_inventory_value);
  if (row.current_inventory_value != null) return Number(row.current_inventory_value);
  const uom = String(row.quantity_uom || "").toLowerCase();
  if (uom === "each") return row.current_inventory == null ? null : Number(row.current_inventory);
  if (uom === "grams" || uom === "gram") return row.current_inventory_grams == null ? null : Number(row.current_inventory_grams);
  return row.current_inventory_grams == null
    ? row.current_inventory == null ? null : Number(row.current_inventory)
    : Number(row.current_inventory_grams);
}

function forecastRemainingValue(row) {
  if (row.projected_remaining_qty != null) return Number(row.projected_remaining_qty);
  const inventory = forecastInventoryValue(row);
  return inventory == null ? null : inventory - Number(row.required_qty || 0);
}

function forecastNeededToOrderValue(row) {
  if (row.needed_to_order_qty != null) return Number(row.needed_to_order_qty);
  const remaining = forecastRemainingValue(row);
  return remaining == null ? null : Math.max(0, -remaining);
}

function formatReportQty(value) {
  if (value == null || value === "") return "";
  const n = Number(value || 0);
  return Math.abs(n) >= 100
    ? n.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function filteredForecastRows(rows, query = {}) {
  const keyword = String(query.search || query.q || "").trim().toLowerCase();
  const ingredientType = String(query.ingredient_type || query.type || "").trim();
  const typeOrder = { Hijnx: 1, SB: 2, "SB/Hijnx": 3 };
  return rows.filter((row) => {
    const matchesKeyword = !keyword || ["ingredient_name", "quantity_uom", "products"].some((field) => (
      String(row[field] ?? "").toLowerCase().includes(keyword)
    ));
    const matchesType = !ingredientType || row.ingredient_type === ingredientType;
    return matchesKeyword && matchesType;
  }).sort((a, b) => (typeOrder[a.ingredient_type] || 9) - (typeOrder[b.ingredient_type] || 9)
    || String(a.ingredient_name || "").localeCompare(String(b.ingredient_name || "")));
}

function writePdfTableRow(doc, columns, values, options = {}) {
  const startY = doc.y;
  const padding = 4;
  const heights = columns.map((column, index) => (
    doc.heightOfString(String(values[index] ?? ""), {
      width: column.width - padding * 2,
      align: column.align || "left",
    }) + padding * 2
  ));
  const rowHeight = Math.max(options.minHeight || 18, ...heights);
  if (startY + rowHeight > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
  }
  const y = doc.y;
  let x = doc.page.margins.left;
  columns.forEach((column, index) => {
    doc.rect(x, y, column.width, rowHeight).stroke("#d9e2e5");
    if (options.fill) doc.rect(x, y, column.width, rowHeight).fillAndStroke(options.fill, "#d9e2e5");
    doc.fillColor(options.color || "#172026")
      .font(options.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(options.fontSize || 8)
      .text(String(values[index] ?? ""), x + padding, y + padding, {
        width: column.width - padding * 2,
        align: column.align || "left",
      });
    x += column.width;
  });
  doc.y = y + rowHeight;
}

function streamForecastPdf(res, report, rows, query = {}) {
  const doc = new PDFDocument({ size: "LETTER", layout: "landscape", margin: 32 });
  const filename = `ingredient-forecast-${report.filters.start}-${report.filters.end}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  doc.pipe(res);

  const typeLabel = query.ingredient_type || query.type || "All types";
  const searchLabel = query.search || query.q || "None";
  doc.font("Helvetica-Bold").fontSize(18).fillColor("#172026").text("Ingredient Forecast Report");
  doc.moveDown(0.25);
  doc.font("Helvetica").fontSize(9).fillColor("#5f6c72")
    .text(`${report.filters.start} through ${report.filters.end}`)
    .text(`Time Period: ${report.filters.weeks} week${report.filters.weeks === 1 ? "" : "s"} | Search: ${searchLabel} | Item Type: ${typeLabel} | Rows: ${rows.length}`)
    .text(`Generated: ${new Date().toLocaleString("en-US")}`);
  doc.moveDown(0.75);

  const totals = rows.reduce((map, row) => {
    const uom = row.quantity_uom || "units";
    const current = map.get(uom) || { usage: 0, order: 0 };
    current.usage += Number(row.required_qty || 0);
    current.order += Number(forecastNeededToOrderValue(row) || 0);
    map.set(uom, current);
    return map;
  }, new Map());
  if (totals.size) {
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#172026").text("Date Range Totals");
    doc.font("Helvetica").fontSize(9).fillColor("#172026")
      .text([...totals.entries()].map(([uom, values]) => (
        `${formatReportQty(values.usage)} ${uom} usage | ${formatReportQty(values.order)} ${uom} to order`
      )).join("   "));
    doc.moveDown(0.75);
  }

  const columns = [
    { label: "Ingredient", width: 126 },
    { label: "Type", width: 38 },
    { label: "Range Usage", width: 54, align: "right" },
    { label: "Inventory Start", width: 58, align: "right" },
    { label: "Remaining", width: 54, align: "right" },
    { label: "Need to Order", width: 58, align: "right" },
    { label: "Order Units", width: 74 },
    { label: "UOM", width: 40 },
    { label: "Batches", width: 42, align: "right" },
    { label: "Products", width: 148 },
  ];
  writePdfTableRow(doc, columns, columns.map((column) => column.label), {
    bold: true,
    fill: "#eef3f2",
    fontSize: 7.5,
    minHeight: 20,
  });
  rows.forEach((row) => {
    const remaining = forecastRemainingValue(row);
    writePdfTableRow(doc, columns, [
      row.ingredient_name,
      row.ingredient_type,
      formatReportQty(row.required_qty),
      formatReportQty(forecastInventoryValue(row)),
      formatReportQty(remaining),
      formatReportQty(forecastNeededToOrderValue(row)),
      row.order_units_needed == null ? "" : `${formatReportQty(row.order_units_needed)} ${row.order_unit_uom || "units"}`,
      row.quantity_uom,
      row.scheduled_batches || 0,
      row.products || "",
    ], {
      color: remaining < 0 ? "#b42318" : "#172026",
      fill: remaining < 0 ? "#fde8e8" : "",
    });
  });
  if (!rows.length) {
    doc.font("Helvetica").fontSize(10).fillColor("#5f6c72").text("No forecast rows match the current filters.");
  }
  doc.end();
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
    const ingredientUsage = await scheduledIngredientUsageForecast({ weeks: 26 });
    const dashboardStartDate = nextProductionWeekStart(new Date());
    const dashboardStart = localIsoDate(dashboardStartDate);
    const dashboardEnd = localIsoDate(addDateDays(dashboardStartDate, 24 * 7));
    ok(res, {
      counts: {
        products: (await one("SELECT COUNT(*) AS n FROM products"))?.n || 0,
        ingredients: (await one("SELECT COUNT(*) AS n FROM ingredients"))?.n || 0,
        scheduled_batches: (await one(`
          SELECT COUNT(*) AS n
          FROM production_batches pb
          JOIN weeks w ON w.id = pb.week_id
          WHERE pb.quantity > 0
            AND w.week_start >= @start
            AND w.week_start < @end
        `, { start: dashboardStart, end: dashboardEnd }))?.n || 0,
      },
      ingredientUsage,
      productionWeeks: await all(`
        SELECT id, week_start, label
        FROM weeks
        WHERE week_start >= @start AND week_start < @end
        ORDER BY week_start
      `, { start: dashboardStart, end: dashboardEnd }),
      productionBatches: await all(`
        SELECT pb.id, pb.week_id, w.week_start, pb.batch_type, p.name AS product_name, pb.quantity
        FROM production_batches pb
        JOIN products p ON p.id = pb.product_id
        JOIN weeks w ON w.id = pb.week_id
        WHERE pb.quantity > 0
          AND w.week_start >= @start
          AND w.week_start < @end
        ORDER BY w.week_start, pb.batch_type, p.name
      `, { start: dashboardStart, end: dashboardEnd }),
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

app.post("/api/products", async (req, res) => {
  try {
    const name = String(req.body.name || "").trim();
    const category = String(req.body.category || "").trim();
    const batchSize = Number(req.body.batch_size);
    if (!name) return fail(res, new Error("Production batch name is required"), 400);
    if (!BATCH_TYPES.includes(category)) return fail(res, new Error("Select Hijnx or Snackbar for the batch type"), 400);
    if (batchSize <= 0) return fail(res, new Error("Average batch size must be greater than zero"), 400);
    const existing = await one("SELECT id FROM products WHERE lower(name) = lower(?)", [name]);
    if (existing) return fail(res, new Error("Production batch already exists"), 400);
    const info = await run(
      "INSERT INTO products (name, category, active) VALUES (?, ?, 1)",
      [name, category],
    );
    await run(
      `INSERT INTO product_batch_sizes (product_id, batch_size, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)`,
      [info.lastInsertRowid, batchSize],
    );
    ok(res, await one(`
      SELECT p.id, p.name, p.sku, p.category, p.active, pbs.batch_size
      FROM products p
      LEFT JOIN product_batch_sizes pbs ON pbs.product_id = p.id
      WHERE p.id = ?
    `, [info.lastInsertRowid]));
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/ingredients", async (req, res) => {
  const rows = await all(`
    SELECT id, name, purchase_uom, ingredient_type, is_master, active
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
    const purchaseUom = normalizeIngredientUom(req.body.purchase_uom, name);
    const ingredientType = normalizeIngredientType(req.body.ingredient_type);
    const info = await run(
      `INSERT INTO ingredients
        (name, purchase_uom, ingredient_type, is_master, active)
       VALUES (?, ?, ?, 1, 1)`,
      [name, purchaseUom, ingredientType],
    );
    ok(res, withBomUom(await one(`
      SELECT id, name, purchase_uom, ingredient_type, is_master, active
      FROM ingredients
      WHERE id = ?
    `, [info.lastInsertRowid])));
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/rl-scheduled-batches", async (req, res) => {
  try {
    const dateWindow = dateWindowFromQuery(req.query);
    if (!calendarDbConfigured) {
      return ok(res, {
        configured: false,
        source: null,
        schema: [],
        batches: [],
        message: "TURSO_CALENDAR_URL and TURSO_CALENDAR_TOKEN are not configured.",
      });
    }
    const schema = await cachedCalendarSchema();
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
        WHERE schedule_date >= ? AND schedule_date <= ?
        ORDER BY schedule_date
      `, [dateWindow.start, dateWindow.end]);
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
    const rows = await calendarAll(`
      SELECT *
      FROM ${quoteIdentifier(table.name)}
      WHERE ${orderColumn} >= ? AND ${orderColumn} <= ?
      ORDER BY ${orderColumn}
    `, [dateWindow.start, dateWindow.end]);
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
    const existing = await one("SELECT id, name FROM ingredients WHERE id = ?", [req.params.id]);
    if (!existing) return fail(res, new Error("Inventory item not found"), 404);
    const fields = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name || "").trim();
      if (!name) return fail(res, new Error("Item name is required"), 400);
      const duplicate = await one("SELECT id FROM ingredients WHERE lower(name) = lower(?) AND id <> ?", [name, req.params.id]);
      if (duplicate) return fail(res, new Error("Inventory item already exists"), 400);
      fields.name = name;
    }
    if (req.body.purchase_uom !== undefined) {
      fields.purchase_uom = normalizeIngredientUom(req.body.purchase_uom, fields.name || existing.name);
    }
    if (req.body.ingredient_type !== undefined) {
      fields.ingredient_type = normalizeIngredientType(req.body.ingredient_type);
    }
    if (!Object.keys(fields).length) {
      return ok(res, withBomUom(await one(`
        SELECT id, name, purchase_uom, ingredient_type, is_master, active
        FROM ingredients
        WHERE id = ?
      `, [req.params.id])));
    }
    const sets = Object.keys(fields).map((key) => `${key} = @${key}`).join(", ");
    await run(`UPDATE ingredients SET ${sets} WHERE id = @id`, { ...fields, id: req.params.id });
    ok(res, withBomUom(await one(`
      SELECT id, name, purchase_uom, ingredient_type, is_master, active
      FROM ingredients
      WHERE id = ?
    `, [req.params.id])));
  } catch (error) {
    fail(res, error);
  }
});

app.delete("/api/ingredients/:id", async (req, res) => {
  try {
    const existing = await one("SELECT id, name FROM ingredients WHERE id = ? AND is_master = 1", [req.params.id]);
    if (!existing) return fail(res, new Error("Inventory item not found"), 404);
    const result = await run("DELETE FROM ingredients WHERE id = ? AND is_master = 1", [req.params.id]);
    if (!result.changes) return fail(res, new Error("Inventory item not found"), 404);
    ok(res, { id: Number(req.params.id), name: existing.name });
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
        SELECT p.id, p.name, p.sku, p.category, p.active, pbs.batch_size
        FROM products p
        LEFT JOIN product_batch_sizes pbs ON pbs.product_id = p.id
        WHERE p.active = 1 AND p.category IN ('Hijnx', 'Snackbar')
        ORDER BY p.category, p.name
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
    ok(res, { id: Number(req.params.id), batch_type: batchType, product_id: productId, week_id: weekId, quantity: qty });
  } catch (error) {
    fail(res, error);
  }
});

app.delete("/api/production-batches/:id", async (req, res) => {
  try {
    const result = await run("DELETE FROM production_batches WHERE id = ?", [req.params.id]);
    if (!result.changes) return fail(res, new Error("Scheduled batch not found"), 404);
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

app.get("/api/export/forecast.pdf", async (req, res) => {
  try {
    const report = await scheduledIngredientUsageForecast(req.query);
    const rows = filteredForecastRows(report.rows, req.query);
    streamForecastPdf(res, report, rows, req.query);
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/inventory-upload", async (req, res) => {
  try {
    ok(res, {
      rows: await latestInventoryRows(),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/inventory-upload", express.raw({ type: ["application/pdf", "application/octet-stream"], limit: "20mb" }), async (req, res) => {
  try {
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || "");
    if (!buffer.length) return fail(res, new Error("Upload a PDF inventory valuation report."), 400);
    const parsedRows = rowsFromDistruInventoryPdf(buffer);
    if (!parsedRows.length) return fail(res, new Error("No inventory rows were found in that PDF."), 400);
    const matchedRows = matchInventoryRows(parsedRows, await activeMasterIngredients());
    await replaceLatestInventoryRows(matchedRows);
    const savedRows = await latestInventoryRows();
    ok(res, {
      rows: savedRows,
      matched: savedRows.filter((row) => row.ingredient_id).length,
      unmatched: savedRows.filter((row) => !row.ingredient_id).length,
    });
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/inventory-upload/rematch", async (req, res) => {
  try {
    const rows = await rematchLatestInventoryRows();
    ok(res, {
      rows,
      matched: rows.filter((row) => row.ingredient_id).length,
      unmatched: rows.filter((row) => !row.ingredient_id).length,
    });
  } catch (error) {
    fail(res, error);
  }
});

app.delete("/api/inventory-upload", async (req, res) => {
  try {
    await run("DELETE FROM latest_inventory_rows");
    ok(res, { rows: [] });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/velocity-products", async (req, res) => {
  try {
    const products = await all(`
      SELECT p.id, p.name, p.sku, p.category, p.active, pbs.batch_size
      FROM products p
      LEFT JOIN product_batch_sizes pbs ON pbs.product_id = p.id
      WHERE p.active = 1 AND p.category IN ('Hijnx', 'Snackbar')
      ORDER BY p.category, p.name
    `);
    ok(res, {
      products: products.map(withVelocityBatchYield),
      rows: await latestVelocityRows(),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.get("/api/velocity-batch-sizes", async (req, res) => {
  try {
    ok(res, {
      rows: await all(`
        SELECT p.id AS product_id, p.name AS product_name, p.category AS batch_type, pbs.batch_size
        FROM products p
        LEFT JOIN product_batch_sizes pbs ON pbs.product_id = p.id
        WHERE p.active = 1 AND p.category IN ('Hijnx', 'Snackbar')
        ORDER BY p.category, p.name
      `),
    });
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/velocity-batch-sizes", async (req, res) => {
  try {
    const productId = Number(req.body.product_id);
    const batchSize = Number(req.body.batch_size);
    const product = await one("SELECT id FROM products WHERE id = ? AND active = 1 AND category IN ('Hijnx', 'Snackbar')", [productId]);
    if (!product) return fail(res, new Error("Select a valid production batch"), 400);
    if (batchSize <= 0) return fail(res, new Error("Standard batch size must be greater than zero"), 400);
    await run(
      `INSERT INTO product_batch_sizes (product_id, batch_size, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(product_id) DO UPDATE SET
         batch_size = excluded.batch_size,
         updated_at = CURRENT_TIMESTAMP`,
      [productId, batchSize],
    );
    ok(res, { product_id: productId, batch_size: batchSize });
  } catch (error) {
    fail(res, error);
  }
});

app.patch("/api/velocity-batch-sizes/:productId", async (req, res) => {
  try {
    const productId = Number(req.params.productId);
    const batchSize = Number(req.body.batch_size);
    const product = await one("SELECT id FROM products WHERE id = ? AND active = 1 AND category IN ('Hijnx', 'Snackbar')", [productId]);
    if (!product) return fail(res, new Error("Select a valid production batch"), 400);
    if (batchSize <= 0) return fail(res, new Error("Standard batch size must be greater than zero"), 400);
    await run(
      `INSERT INTO product_batch_sizes (product_id, batch_size, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(product_id) DO UPDATE SET
         batch_size = excluded.batch_size,
         updated_at = CURRENT_TIMESTAMP`,
      [productId, batchSize],
    );
    ok(res, { product_id: productId, batch_size: batchSize });
  } catch (error) {
    fail(res, error);
  }
});

app.delete("/api/velocity-batch-sizes/:productId", async (req, res) => {
  try {
    await run("DELETE FROM product_batch_sizes WHERE product_id = ?", [Number(req.params.productId)]);
    ok(res, { product_id: Number(req.params.productId) });
  } catch (error) {
    fail(res, error);
  }
});

app.delete("/api/velocity/import", async (req, res) => {
  try {
    await run("DELETE FROM latest_velocity_rows");
    ok(res, { cleared: true });
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/velocity/import", express.raw({ type: ["application/pdf", "application/octet-stream"], limit: "10mb" }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return fail(res, new Error("Upload a production needs PDF"), 400);
    }
    const products = await all(`
      SELECT id, name, sku, category, active
      FROM products
      WHERE active = 1 AND category IN ('Hijnx', 'Snackbar')
      ORDER BY category, name
    `);
    const parsedRows = rowsFromVelocityPdf(req.body);
    if (!parsedRows.length) {
      return fail(res, new Error("No SKU and Vel/Day rows were found in this PDF"), 400);
    }
    const rows = matchVelocityRows(parsedRows, products);
    await replaceLatestVelocityRows(rows);
    ok(res, {
      rows,
      parsed_count: parsedRows.length,
      matched_count: rows.filter((row) => row.product_id).length,
      instructions: [
        "Upload the Production Needs Report PDF generated by the velocity/par tool.",
        "The importer reads SKU, Projected units, and Vel/Day from the Production Needs table.",
        "Names are matched to active Hijnx and Snackbar production batches by alias, exact normalized name, then fuzzy token similarity.",
        "Rows with low confidence remain visible as unmatched so an alias or master product name can be corrected.",
      ],
    });
  } catch (error) {
    fail(res, error);
  }
});

const BOM_TRANSFER_FORMAT = "ingredient-projection-bom";
const BOM_TRANSFER_VERSION = 1;

function bomTransferText(value, label, maxLength = 200, required = true) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > maxLength) throw new Error(`${label} is too long`);
  return text;
}

function parseBomTransferFile(buffer) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(buffer || "").toString("utf8"));
  } catch {
    throw new Error("The selected file is not valid BOM JSON");
  }
  if (payload?.format !== BOM_TRANSFER_FORMAT || Number(payload?.version) !== BOM_TRANSFER_VERSION) {
    throw new Error("This is not a supported Ingredient Projection BOM transfer file");
  }
  const sourceProduct = payload?.bom?.product;
  const name = bomTransferText(sourceProduct?.name, "Production batch name");
  const category = bomTransferText(sourceProduct?.category, "Batch type", 50);
  if (!BATCH_TYPES.includes(category)) throw new Error("BOM batch type must be Hijnx or Snackbar");
  const sku = bomTransferText(sourceProduct?.sku, "SKU", 200, false) || null;
  const batchSize = Number(sourceProduct?.batch_size);
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error("BOM Batch QTY must be greater than zero");
  }
  const sourceIngredients = payload?.bom?.ingredients;
  if (!Array.isArray(sourceIngredients) || !sourceIngredients.length) {
    throw new Error("The BOM transfer file does not contain any ingredients");
  }
  if (sourceIngredients.length > 1000) throw new Error("The BOM transfer file contains too many ingredients");
  const ingredientNames = new Set();
  const ingredients = sourceIngredients.map((sourceIngredient, index) => {
    const ingredientName = bomTransferText(sourceIngredient?.name, `Ingredient ${index + 1} name`);
    const ingredientKey = ingredientName.toLowerCase();
    if (ingredientNames.has(ingredientKey)) throw new Error(`Duplicate ingredient in transfer file: ${ingredientName}`);
    ingredientNames.add(ingredientKey);
    const quantityPerUnit = Number(sourceIngredient?.quantity_per_unit);
    if (!Number.isFinite(quantityPerUnit) || quantityPerUnit <= 0) {
      throw new Error(`Quantity for ${ingredientName} must be greater than zero`);
    }
    const purchaseUom = normalizeIngredientUom(
      sourceIngredient?.purchase_uom || sourceIngredient?.quantity_uom,
      ingredientName,
    );
    return {
      name: ingredientName,
      purchase_uom: purchaseUom,
      ingredient_type: normalizeIngredientType(sourceIngredient?.ingredient_type),
      quantity_per_unit: quantityPerUnit,
      quantity_uom: purchaseUom,
      notes: bomTransferText(sourceIngredient?.notes, `${ingredientName} notes`, 1000, false) || null,
    };
  });
  return {
    product: { name, category, sku, batch_size: batchSize },
    ingredients,
  };
}

app.get("/api/formulas", async (req, res) => {
  try {
    ok(res, {
      products: await all(`
        SELECT p.id, p.name, p.sku, p.category, p.active, pbs.batch_size
        FROM products p
        LEFT JOIN product_batch_sizes pbs ON pbs.product_id = p.id
        WHERE p.active = 1 AND p.category IN ('Hijnx', 'Snackbar')
        ORDER BY p.category, p.name
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

app.get("/api/formulas/export/:productId", async (req, res) => {
  try {
    const product = await one(`
      SELECT p.id, p.name, p.sku, p.category, pbs.batch_size
      FROM products p
      LEFT JOIN product_batch_sizes pbs ON pbs.product_id = p.id
      WHERE p.id = ? AND p.active = 1 AND p.category IN ('Hijnx', 'Snackbar')
    `, [req.params.productId]);
    if (!product) return fail(res, new Error("Production batch not found"), 404);
    if (!(Number(product.batch_size) > 0)) {
      return fail(res, new Error("Set a Batch QTY before exporting this BOM"), 400);
    }
    const ingredients = await all(`
      SELECT i.name,
             i.purchase_uom,
             i.ingredient_type,
             pf.quantity_per_unit,
             pf.quantity_uom,
             pf.notes
      FROM product_formulas pf
      JOIN ingredients i ON i.id = pf.ingredient_id
      WHERE pf.product_id = ? AND pf.source_sheet IS NULL
      ORDER BY i.name
    `, [product.id]);
    if (!ingredients.length) return fail(res, new Error("This production batch does not have a BOM to export"), 400);
    const transfer = {
      format: BOM_TRANSFER_FORMAT,
      version: BOM_TRANSFER_VERSION,
      exported_at: new Date().toISOString(),
      source: process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get("host")}`,
      bom: {
        product: {
          name: product.name,
          sku: product.sku || null,
          category: product.category,
          batch_size: Number(product.batch_size),
        },
        ingredients: ingredients.map((ingredient) => ({
          name: ingredient.name,
          purchase_uom: normalizeIngredientUom(ingredient.purchase_uom, ingredient.name),
          ingredient_type: normalizeIngredientType(ingredient.ingredient_type),
          quantity_per_unit: Number(ingredient.quantity_per_unit),
          quantity_uom: normalizeIngredientUom(ingredient.quantity_uom, ingredient.name),
          notes: ingredient.notes || null,
        })),
      },
    };
    const filename = `${product.name}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "formula";
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}.bom.json"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(`${JSON.stringify(transfer, null, 2)}\n`);
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/formulas/import", express.raw({ type: "application/octet-stream", limit: "2mb" }), async (req, res) => {
  try {
    const transfer = parseBomTransferFile(req.body);
    const result = await withTransaction(async (tx) => {
      let product = await tx.one("SELECT id, name FROM products WHERE lower(name) = lower(?)", [transfer.product.name]);
      const createdProduct = !product;
      if (product) {
        await tx.run(
          "UPDATE products SET sku = ?, category = ?, active = 1 WHERE id = ?",
          [transfer.product.sku, transfer.product.category, product.id],
        );
      } else {
        const inserted = await tx.run(
          "INSERT INTO products (name, sku, category, active) VALUES (?, ?, ?, 1)",
          [transfer.product.name, transfer.product.sku, transfer.product.category],
        );
        product = { id: inserted.lastInsertRowid, name: transfer.product.name };
      }
      await tx.run(
        `INSERT INTO product_batch_sizes (product_id, batch_size, updated_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(product_id) DO UPDATE SET
           batch_size = excluded.batch_size,
           updated_at = CURRENT_TIMESTAMP`,
        [product.id, transfer.product.batch_size],
      );
      const existingFormulaCount = Number((await tx.one(
        "SELECT COUNT(*) AS count FROM product_formulas WHERE product_id = ? AND source_sheet IS NULL",
        [product.id],
      ))?.count || 0);
      const ingredientIds = [];
      let createdIngredients = 0;
      for (const ingredient of transfer.ingredients) {
        let targetIngredient = await tx.one("SELECT id FROM ingredients WHERE lower(name) = lower(?)", [ingredient.name]);
        if (targetIngredient) {
          await tx.run(
            `UPDATE ingredients
             SET purchase_uom = ?, ingredient_type = ?, is_master = 1, active = 1
             WHERE id = ?`,
            [ingredient.purchase_uom, ingredient.ingredient_type, targetIngredient.id],
          );
        } else {
          const inserted = await tx.run(
            `INSERT INTO ingredients
              (name, purchase_uom, ingredient_type, is_master, active)
             VALUES (?, ?, ?, 1, 1)`,
            [ingredient.name, ingredient.purchase_uom, ingredient.ingredient_type],
          );
          targetIngredient = { id: inserted.lastInsertRowid };
          createdIngredients += 1;
        }
        ingredientIds.push({ ...ingredient, id: targetIngredient.id });
      }
      await tx.run("DELETE FROM product_formulas WHERE product_id = ? AND source_sheet IS NULL", [product.id]);
      for (const ingredient of ingredientIds) {
        await tx.run(
          `INSERT INTO product_formulas
            (product_id, ingredient_id, quantity_per_unit, quantity_uom, notes)
           VALUES (?, ?, ?, ?, ?)`,
          [product.id, ingredient.id, ingredient.quantity_per_unit, ingredient.quantity_uom, ingredient.notes],
        );
      }
      return {
        product_id: Number(product.id),
        product_name: transfer.product.name,
        created_product: createdProduct,
        batch_size: transfer.product.batch_size,
        imported_ingredients: ingredientIds.length,
        created_ingredients: createdIngredients,
        replaced_ingredients: existingFormulaCount,
      };
    });
    ok(res, result);
  } catch (error) {
    fail(res, error, 400);
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
    const quantityUom = normalizeIngredientUom(ingredient.purchase_uom, ingredient.name);
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
    ok(res, { product_id, ingredient_id });
  } catch (error) {
    fail(res, error);
  }
});

app.post("/api/formulas/copy", async (req, res) => {
  try {
    const { source_product_id, target_product_id } = req.body;
    if (!source_product_id || !target_product_id) {
      return fail(res, new Error("Select a source and target production batch"), 400);
    }
    if (String(source_product_id) === String(target_product_id)) {
      return fail(res, new Error("Select a different batch to copy from"), 400);
    }
    const sourceProduct = await one("SELECT * FROM products WHERE id = ? AND category IN ('Hijnx', 'Snackbar')", [source_product_id]);
    const targetProduct = await one("SELECT * FROM products WHERE id = ? AND category IN ('Hijnx', 'Snackbar')", [target_product_id]);
    if (!sourceProduct || !targetProduct) {
      return fail(res, new Error("Select valid production batches"), 400);
    }
    const sourceFormulas = await all(`
      SELECT ingredient_id, quantity_per_unit, quantity_uom, notes
      FROM product_formulas
      WHERE product_id = ? AND source_sheet IS NULL
      ORDER BY id
    `, [source_product_id]);
    if (!sourceFormulas.length) {
      return fail(res, new Error("The selected batch does not have a BOM to copy"), 400);
    }

    await run("DELETE FROM product_formulas WHERE product_id = ? AND source_sheet IS NULL", [target_product_id]);
    for (const formula of sourceFormulas) {
      await run(
        `INSERT INTO product_formulas
          (product_id, ingredient_id, quantity_per_unit, quantity_uom, notes)
         VALUES (?, ?, ?, ?, ?)`,
        [target_product_id, formula.ingredient_id, formula.quantity_per_unit, formula.quantity_uom, formula.notes || null],
      );
    }
    ok(res, {
      source_product_id: Number(source_product_id),
      target_product_id: Number(target_product_id),
      copied: sourceFormulas.length,
    });
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
    const quantityUom = normalizeIngredientUom(ingredient.purchase_uom, ingredient.name);
    await run(
      "UPDATE product_formulas SET ingredient_id = ?, quantity_per_unit = ?, quantity_uom = ?, notes = ? WHERE id = ?",
      [ingredientId, quantityPerUnit, quantityUom, req.body.notes ?? existing.notes ?? null, req.params.id],
    );
    ok(res, { id: Number(req.params.id), ingredient_id: ingredientId, quantity_per_unit: quantityPerUnit, quantity_uom: quantityUom });
  } catch (error) {
    fail(res, error);
  }
});

app.delete("/api/formulas/:id", async (req, res) => {
  try {
    const result = await run("DELETE FROM product_formulas WHERE id = ? AND source_sheet IS NULL", [req.params.id]);
    if (!result.changes) return fail(res, new Error("BOM ingredient not found"), 404);
    ok(res, { id: Number(req.params.id) });
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
