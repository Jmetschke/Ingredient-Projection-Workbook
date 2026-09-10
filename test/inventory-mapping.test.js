import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { inventoryWeightConversion } from '../src/inventory-mapping.js';
import { INGREDIENT_UNIT_CONVERSION_BY_NAME } from '../src/ingredient-unit-conversions.js';

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const context = vm.createContext({ INGREDIENT_UNIT_CONVERSION_BY_NAME });
vm.runInContext(`
  ${source.slice(source.indexOf('function normalizeMatchText('), source.indexOf('function pdfText('))}
  ${source.slice(source.indexOf('function inventoryConversionForName('), source.indexOf('function rowsFromDistruInventoryPdf('))}
  ${source.slice(source.indexOf('function scoreIngredientMatch('), source.indexOf('function matchVelocityRows('))}
  function normalizeIngredientType(value) { return value || 'SB/Hijnx'; }
`, context);

const ingredient = { id: 42, name: 'bees wax', purchase_uom: 'grams' };
const row = { uploaded_name: 'Bees Wax', current_qty: 2.1, quantity_uom: 'grams' };

test('package weights support grams, kilograms, pounds and ounces', () => {
  for (const [unit, expected] of [['g', 25], ['kg', 25000], ['lb', 11339.80925], ['oz', 708.738078125]]) {
    const result = inventoryWeightConversion({ inventory_uom: 'Box', package_weight: 25, weight_unit: unit });
    assert.equal(result.grams_per_inventory_unit, expected);
  }
});

test('invalid weights and unknown units cannot be saved', () => {
  for (const weight of ['', 0, -1, 'abc', Infinity]) {
    assert.throws(() => inventoryWeightConversion({ inventory_uom: 'Box', package_weight: weight, weight_unit: 'g' }));
  }
  assert.throws(() => inventoryWeightConversion({ inventory_uom: 'Box', package_weight: 1, weight_unit: 'gal' }));
  assert.throws(() => inventoryWeightConversion({ inventory_uom: '', package_weight: 1, weight_unit: 'g' }));
});

test('saved package weight overrides the bees wax one-gram default on each upload', () => {
  // Example weight for testing only; the actual box weight must be supplied by the user.
  const override = { ...inventoryWeightConversion({ inventory_uom: 'Box', package_weight: 10, weight_unit: 'kg' }), ingredient_id: 42 };
  const aliases = new Map([['bees wax', ingredient]]);
  const overrides = new Map([['bees wax', override]]);
  const [matched] = context.matchInventoryRows([row], [ingredient], aliases, overrides);
  assert.equal(matched.current_qty, 2.1);
  assert.equal(matched.current_qty_grams, 21000);
  assert.equal(matched.inventory_uom, 'Box');
  const [rematched] = context.matchInventoryRows([matched], [ingredient], aliases, overrides);
  assert.equal(rematched.current_qty_grams, 21000);
  assert.equal(rematched.current_qty, 2.1);
});

test('a weight saved for a different ingredient is not applied when remapping', () => {
  const [matched] = context.matchInventoryRows([row], [ingredient], new Map(), new Map([['bees wax', { ingredient_id: 99, grams_per_inventory_unit: 10000 }]]));
  assert.equal(matched.current_qty_grams, 2.1);
});

test('each items remain counts and do not gain gram totals', () => {
  const converted = context.withInventoryConversion({ current_qty: 3, quantity_uom: 'each' }, 'Whoppie Cookie');
  assert.equal(converted.current_qty, 2400);
  assert.equal(converted.current_qty_grams, null);
  assert.equal(context.withInventoryConversion(converted, 'Whoppie Cookie').current_qty, 2400);
  assert.equal(context.withInventoryConversion({ current_qty: 3, quantity_uom: 'each' }, 'bees wax').current_qty_grams, null);
});
