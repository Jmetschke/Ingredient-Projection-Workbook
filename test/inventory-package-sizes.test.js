import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createClient } from '@libsql/client';
import { inventoryWeightConversion, resolveInventoryPackageSize } from '../src/inventory-mapping.js';
import { bomUomForIngredient } from '../src/master-ingredients.js';
import { INGREDIENT_UNIT_CONVERSION_BY_NAME } from '../src/ingredient-unit-conversions.js';

const clientSource = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const serverSource = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const helper = clientSource.slice(clientSource.indexOf('function inventoryPackageInfo('), clientSource.indexOf('async function editDashboardPackageSizes('));
const context = vm.createContext({});
vm.runInContext(helper, context);
const size = { inventory_uom: 'unit', package_weight: 3.5, weight_unit: 'kg', grams_per_inventory_unit: 3500 };
const inventory = { ingredient_id: 1, ingredient_name: 'Test ingredient', quantity_uom: 'grams', current_inventory: 7000, current_inventory_grams: 7000, grams_per_inventory_unit: 1, inventory_source_uom: 'grams' };

test('7000 grams represent two 3.5 kg units; fractional packages and zero are preserved', () => {
  assert.equal(context.inventoryPackageInfo(inventory, size).count, 2);
  assert.equal(context.inventoryPackageInfo(inventory, size).description, '1 unit = 3.5 kg');
  assert.equal(context.inventoryPackageInfo({ ...inventory, current_inventory_grams: 1750 }, size).count, 0.5);
  assert.equal(context.inventoryPackageInfo({ ...inventory, current_inventory_grams: 0 }, size).count, 0);
  assert.equal(context.inventoryPackageInfo({ ...inventory, current_inventory_grams: null }, size).count, null);
  assert.equal(context.inventoryPackageInfo(inventory).description, 'Package size not set');
  assert.equal(context.inventoryPackageInfo({ ...inventory, quantity_uom: 'each', current_inventory: 42 }, size).count, 42);
});

test('printed report refreshes saved sizes and uses grams divided by package size', async () => {
  let html;
  const printContext = vm.createContext({
    api: async endpoint => endpoint === '/api/inventory-package-sizes' ? [{ id: 1, ...size }] : { ingredientUsage: { rows: [inventory], inventory_as_of: '2026-09-30' } },
    window: { open: () => ({ document: { write: value => { html = value; }, close() {} } }) },
    escapeHtml: String, qty: String, formatInventoryAsOf: String,
  });
  vm.runInContext(helper, printContext);
  vm.runInContext(clientSource.slice(clientSource.indexOf('async function printDashboardInventory('), clientSource.indexOf('\nfunction ', clientSource.indexOf('async function printDashboardInventory('))), printContext);
  await printContext.printDashboardInventory([], '');
  assert.match(html, /1 unit = 3.5 kg/);
  assert.match(html, /<td class="numeric">2 \(unit\)<\/td>/);
  assert.match(html, /<td class="numeric">7000<\/td>/);
});

test('saved package sizes survive uploads and invalid changes; saving never alters grams', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'package-size-test-'));
  const db = createClient({ url: `file:${path.join(directory, 'test.sqlite')}` });
  try {
    await db.executeMultiple(fs.readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
    await db.execute('ALTER TABLE ingredients ADD COLUMN is_master INTEGER NOT NULL DEFAULT 1');
    await db.execute("INSERT INTO ingredients (id, name, purchase_uom) VALUES (1, 'Test ingredient', 'grams'), (2, 'Boxes', 'each'), (3, 'Chocolate Chips', 'grams')");
    const all = async (sql, args = []) => (await db.execute({ sql, args })).rows.map(row => ({ ...row }));
    const one = async (sql, args = []) => (await all(sql, args))[0];
    const run = (sql, args = []) => db.execute({ sql, args });
    const routes = new Map();
    const register = method => (url, ...handlers) => routes.set(`${method} ${url}`, handlers.at(-1));
    let response;
    const ctx = vm.createContext({
      all, one, run, Buffer, inventoryWeightConversion, resolveInventoryPackageSize, bomUomForIngredient, INGREDIENT_UNIT_CONVERSION_BY_NAME,
      INGREDIENT_TYPES: new Set(['SB', 'Hijnx', 'SB/Hijnx']),
      app: { get: register('GET'), put: register('PUT'), post: register('POST') },
      express: { raw: () => null },
      ok: (_res, data) => { response = { status: 200, data }; },
      fail: (_res, error, status = 500) => { response = { status, error: error.message }; },
      rowsFromDistruInventoryPdf: () => [{ uploaded_name: 'Test ingredient', current_qty: 10500, quantity_uom: 'grams' }],
      activeMasterIngredients: () => all('SELECT * FROM ingredients'),
      inventoryAliasIngredients: async () => new Map(),
    });
    const load = (from, to) => vm.runInContext(serverSource.slice(serverSource.indexOf(from), serverSource.indexOf(to, serverSource.indexOf(from))), ctx);
    load('function withBomUom(', 'function pdfText(');
    load('function inventoryConversionForName(', 'function rowsFromDistruInventoryPdf(');
    load('function scoreIngredientMatch(', 'function matchVelocityRows(');
    load('async function latestInventoryRows(', 'async function activeMasterIngredients(');
    load('async function inventoryUnitOverrides(', 'async function rematchLatestInventoryRows(');
    load('app.get("/api/inventory-package-sizes"', 'app.post("/api/ingredients"');
    load('app.post("/api/inventory-upload",', 'app.post("/api/inventory-upload/rematch"');
    await ctx.replaceLatestInventoryRows([{ uploaded_name: 'Test ingredient', ingredient_id: 1, ingredient_name: 'Test ingredient', quantity_uom: 'grams', current_qty: 7000, current_qty_grams: 7000 }]);
    const save = body => routes.get('PUT /api/inventory-package-sizes/:id')({ params: { id: 1 }, body }, {});
    await save(size);
    assert.equal(response.status, 200);
    assert.equal((await ctx.latestInventoryRows())[0].current_qty_grams, 7000);
    for (const invalid of [0, -1, 'abc', Infinity]) {
      await save({ ...size, package_weight: invalid });
      assert.equal(response.status, 400);
    }
    await routes.get('PUT /api/inventory-package-sizes/:id')({ params: { id: 2 }, body: size }, {});
    assert.equal(response.status, 400);
    await routes.get('POST /api/inventory-upload')({ body: Buffer.from('fixture') }, {});
    assert.equal(response.status, 200);
    assert.deepEqual(Array.from(response.data.preserved_package_sizes), ['Test ingredient']);
    assert.equal((await ctx.latestInventoryRows())[0].current_qty, 10500);
    await routes.get('GET /api/inventory-package-sizes')({}, {});
    const saved = response.data.find(row => row.id === 1);
    assert.equal(saved.grams_per_inventory_unit, 3500);
    assert.equal(saved.package_weight, 3.5);
    assert.equal(saved.weight_unit, 'kg');
    const chocolate = response.data.find(row => row.id === 3);
    assert.equal(chocolate.inventory_uom, '10kg Box');
    assert.equal(chocolate.grams_per_inventory_unit, 10000);
    assert.equal(chocolate.package_size_source, 'default');
    let printed = '';
    const printContext = vm.createContext({
      api: async endpoint => endpoint === '/api/inventory-package-sizes' ? response.data : [{ id: 3, name: 'Chocolate Chips', purchase_uom: 'grams', current_inventory_count: 7580 }],
      window: { open: () => ({ document: { write: html => { printed = html; }, close() {} } }) },
      escapeHtml: String, qty: String, Intl, Date,
    });
    vm.runInContext(helper, printContext);
    vm.runInContext(clientSource.slice(clientSource.indexOf('async function printInventoryCountSheet('), clientSource.indexOf('async function renderFormulas(')), printContext);
    await printContext.printInventoryCountSheet([{ id: 3 }]);
    assert.ok(printed.includes('0.758 (10kg Box)'));
    assert.ok(!printed.includes('Package size not set'));

  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('report sizes reuse existing conversions and preserve manual override priority', () => {
  const chocolate = { id: 3, name: 'Chocolate Chips' };
  const defaults = INGREDIENT_UNIT_CONVERSION_BY_NAME.get('chocolate chips');
  const fallback = resolveInventoryPackageSize(chocolate, [], [], defaults);
  assert.equal(fallback.grams_per_inventory_unit, 10000);
  assert.equal(fallback.inventory_uom, '10kg Box');
  assert.equal(fallback.package_size_source, 'default');
  assert.equal(context.inventoryPackageInfo({ ...inventory, current_inventory_grams: 7580 }, fallback).count, 0.758);

  const imported = { ingredient_id: 3, inventory_uom: 'bag', grams_per_inventory_unit: 2000 };
  const corrected = { ingredient_id: 3, inventory_uom: 'box', grams_per_inventory_unit: 3500, package_weight: 3.5, weight_unit: 'kg' };
  assert.equal(resolveInventoryPackageSize(chocolate, [], [imported], defaults).grams_per_inventory_unit, 2000);
  assert.equal(resolveInventoryPackageSize(chocolate, [corrected], [imported], defaults).grams_per_inventory_unit, 3500);
  assert.equal(resolveInventoryPackageSize({ ...chocolate, ...size }, [corrected], [imported], defaults).package_size_source, 'manual');
  // Manual inventory entries store grams, not a new package size.
  const manualGrams = { ingredient_id: 3, match_method: 'manual_update', inventory_uom: 'grams', grams_per_inventory_unit: 1 };
  assert.equal(resolveInventoryPackageSize(chocolate, [], [manualGrams], defaults).grams_per_inventory_unit, 10000);
  const conflict = resolveInventoryPackageSize(chocolate, [corrected, { ...corrected, grams_per_inventory_unit: 5000 }], [], defaults);
  assert.equal(conflict.package_size_source, 'conflict');
  assert.equal(context.inventoryPackageInfo(inventory, conflict).count, null);
});
