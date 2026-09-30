import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bomUomForIngredient } from '../src/master-ingredients.js';

const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

async function inventoryResponse(ingredients, inventory) {
  let handler;
  let result;
  const context = vm.createContext({
    app: { get: (_path, callback) => { handler = callback; } },
    all: async () => ingredients,
    latestInventoryRows: async () => inventory,
    ok: (_res, data) => { result = data; },
    bomUomForIngredient,
    INGREDIENT_TYPES: new Set(['SB', 'Hijnx', 'SB/Hijnx']),
  });
  vm.runInContext(server.slice(server.indexOf('function withBomUom('), server.indexOf('function pdfText(')), context);
  vm.runInContext(server.slice(server.indexOf('app.get("/api/ingredients"'), server.indexOf('app.get("/api/inventory-package-sizes"')), context);
  await handler({}, {});
  return result;
}

test('inventory count uses recorded quantities without a gram conversion and matches by name', async () => {
  const rows = await inventoryResponse([
    { id: 1, name: 'Flour', purchase_uom: 'grams' },
    { id: 2, name: 'Sugar', purchase_uom: 'grams' },
    { id: 3, name: 'Boxes', purchase_uom: 'EACH' },
    { id: 4, name: 'Missing', purchase_uom: 'grams' },
  ], [
    { ingredient_id: 1, current_qty: 125, current_qty_grams: null },
    { ingredient_id: null, uploaded_name: 'Sugar', current_qty: 20, current_qty_grams: null },
    { ingredient_id: 3, current_qty: 0, current_qty_grams: null },
  ]);
  assert.deepEqual(Array.from(rows, row => row.current_inventory_count), [125, 20, 0, null]);

  let html = '';
  const context = vm.createContext({
    api: async () => rows,
    window: { open: () => ({ document: { write: value => { html = value; }, close() {} } }) },
    escapeHtml: String, qty: String, Intl, Date,
  });
  vm.runInContext(client.slice(client.indexOf('function inventoryPackageInfo('), client.indexOf('async function editDashboardPackageSizes(')), context);
  vm.runInContext(client.slice(client.indexOf('async function printInventoryCountSheet('), client.indexOf('async function renderFormulas(')), context);
  await context.printInventoryCountSheet(rows.map(row => ({ id: row.id })));
  for (const quantity of ['125', '20', '0', '—']) {
    assert.ok(html.includes(`<td class="numeric">${quantity}</td>`));
  }
  const today = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date());
  assert.ok(html.includes(`Inventory as of ${today}`));
  assert.ok(html.includes('<th>Physical Count</th>'));
});

test('converted quantities aggregate and ingredient ID takes precedence over name', async () => {
  const rows = await inventoryResponse([{ id: 1, name: 'Flour', purchase_uom: 'grams' }], [
    { ingredient_id: 1, ingredient_name: 'Flour', current_qty: 2, current_qty_grams: 2000 },
    { ingredient_id: 1, ingredient_name: 'Flour', current_qty: 3, current_qty_grams: 3000 },
    { ingredient_id: 9, ingredient_name: 'Flour', current_qty: 100, current_qty_grams: 100000 },
  ]);
  assert.equal(rows[0].current_inventory_count, 5000);
});


test('count sheet includes grams, saved package size, fractional and zero units, and blank physical counts', async () => {
  const rows = [
    { id: 1, name: 'Product A', purchase_uom: 'grams', current_inventory_count: 7000 },
    { id: 2, name: 'Partial box', purchase_uom: 'grams', current_inventory_count: 1750 },
    { id: 3, name: 'Empty box', purchase_uom: 'grams', current_inventory_count: 0 },
    { id: 4, name: 'Unknown size', purchase_uom: 'grams', current_inventory_count: 10 },
    { id: 5, name: 'Missing inventory', purchase_uom: 'grams', current_inventory_count: null },
  ];
  const sizes = [1, 2, 3, 5].map(id => ({ id, inventory_uom: 'box', package_weight: 3.5, weight_unit: 'kg', grams_per_inventory_unit: 3500 }));
  let html = '';
  const context = vm.createContext({
    api: async endpoint => endpoint === '/api/ingredients' ? rows : sizes,
    window: { open: () => ({ document: { write: value => { html = value; }, close() {} } }) },
    escapeHtml: String, qty: String, Intl, Date,
  });
  vm.runInContext(client.slice(client.indexOf('function inventoryPackageInfo('), client.indexOf('async function editDashboardPackageSizes(')), context);
  vm.runInContext(client.slice(client.indexOf('async function printInventoryCountSheet('), client.indexOf('async function renderFormulas(')), context);
  await context.printInventoryCountSheet(rows);
  assert.match(html, /<td class="numeric">7000<\/td>/);
  assert.match(html, /1 box = 3.5 kg/);
  for (const count of ['2', '0.5', '0']) assert.ok(html.includes(`<td class="numeric">${count} (box)</td>`));
  assert.match(html, /Package size not set/);
  assert.equal((html.match(/class="count-space"/g) || []).length, 5);
  assert.ok(html.includes('<th>Units on Hand</th>'));
});
