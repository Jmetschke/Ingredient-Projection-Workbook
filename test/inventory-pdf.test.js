import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { bomUomForIngredient } from '../src/master-ingredients.js';
import { INGREDIENT_UNIT_CONVERSION_BY_NAME } from '../src/ingredient-unit-conversions.js';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
function parser(items) {
  const context = vm.createContext({ bomUomForIngredient, INGREDIENT_UNIT_CONVERSION_BY_NAME });
  vm.runInContext(source.slice(source.indexOf('function normalizeIngredientUom('), source.indexOf('function pdfText(')), context);
  vm.runInContext(source.slice(source.indexOf('function cleanPdfCell('), source.indexOf('function scoreProductMatch(')), context);
  context.extractDistruInventoryTextItems = () => items;
  return context;
}
// Column positions and quantities from the supplied October 14 Distru report.
const row = (name, quantity, y, available = quantity) => [
  { page: 6, x: 4.5, y, text: name },
  { page: 6, x: 216.5, y, text: 'EO-0000153' },
  { page: 6, x: 495, y, text: String(available) },
  { page: 6, x: 662, y, text: String(quantity) },
];

test('PDF quantity is a source-unit count; conversion occurs after extraction', () => {
  const ctx = parser([...row('Clove', 0.62, 5539), ...row('Bees Wax', 0.9384, 5359)]);
  const rows = ctx.rowsFromDistruInventoryPdf(null);
  assert.equal(rows.length, 2);
  const clove = rows.find(row => row.uploaded_name === 'Clove');
  assert.equal(clove.current_qty, 0.62);
  assert.equal(ctx.withInventoryConversion(clove).current_qty_grams, 2170);
  const wax = ctx.withInventoryConversion(rows.find(row => row.uploaded_name === 'Bees Wax'));
  assert.equal(wax.current_qty, 0.9384);
  assert.equal(wax.current_qty_grams, null);
});

test('single-word zero-stock rows survive and active/on-hand takes priority over available', () => {
  const ctx = parser([...row('Clove', 0, 5539, 2), ...row('Lavender', 0, 5841)]);
  const rows = ctx.rowsFromDistruInventoryPdf(null);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].current_qty, 0);
  assert.equal(rows[1].current_qty, 0);
});

test('wrapped item names retain their quantity and exclude SKU and vendor text', () => {
  const ctx = parser([
    {page: 4, x: 4.5, y: 3709, text: 'Crimson Toro (Cranberry/Pomegrante) Abstrax'},
    {page: 4, x: 4.5, y: 3722, text: 'Terps'},
    {page: 4, x: 662, y: 3715, text: '42.00'},
    {page: 4, x: 293, y: 3715, text: 'Abstrax'},
  ]);
  const rows = ctx.rowsFromDistruInventoryPdf(null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].uploaded_name, 'Crimson Toro (Cranberry/Pomegrante) Abstrax Terps');
  assert.equal(rows[0].current_qty, 42);
});
