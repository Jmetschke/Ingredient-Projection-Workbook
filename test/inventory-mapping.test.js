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

test('saved package weight converts bees wax package counts on each upload', () => {
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
  assert.equal(matched.current_qty_grams, null);
});

test('each items remain counts and do not gain gram totals', () => {
  const converted = context.withInventoryConversion({ current_qty: 3, quantity_uom: 'each' }, 'Whoppie Cookie');
  assert.equal(converted.current_qty, 2400);
  assert.equal(converted.current_qty_grams, null);
  assert.equal(context.withInventoryConversion(converted, 'Whoppie Cookie').current_qty, 2400);
  assert.equal(context.withInventoryConversion({ current_qty: 3, quantity_uom: 'each' }, 'bees wax').current_qty_grams, null);
});

test('clove packages convert to grams and repair the legacy one-gram assumption', () => {
  const clove = { uploaded_name: 'Clove', current_qty: 0.62, quantity_uom: 'grams' };
  assert.equal(context.withInventoryConversion(clove, 'clove').current_qty_grams, 2170);
  const legacy = { ...clove, inventory_uom: 'Gram', grams_per_inventory_unit: 1, current_qty_grams: 0.62 };
  assert.equal(context.withInventoryConversion(legacy, 'clove').current_qty_grams, 2170);
  const converted = context.withInventoryConversion(legacy, 'clove');
  assert.equal(context.withInventoryConversion(converted, 'clove').current_qty_grams, 2170);
  assert.equal(converted.current_qty, 0.62);
});

test('unverified package weights remain unresolved instead of becoming grams', () => {
  for (const name of ['bees wax', 'shea butter', 'eucalyptus', 'black pepper', 'copaiba']) {
    const converted = context.withInventoryConversion({ uploaded_name: name, current_qty: 0.62,
      quantity_uom: 'grams', inventory_uom: 'Gram', grams_per_inventory_unit: 1, current_qty_grams: 0.62 }, name);
    assert.equal(converted.current_qty, 0.62);
    assert.equal(converted.current_qty_grams, null);
    assert.equal(converted.grams_per_inventory_unit, null);
  }
});

test('saved package sizes resolve package imports, and manual gram adjustments stay grams', () => {
  const size = { ingredient_id: 42, inventory_uom: 'box', grams_per_inventory_unit: 10000 };
  const [matched] = context.matchInventoryRows([row], [ingredient], new Map(), new Map([['ingredient:42', size]]));
  assert.equal(matched.current_qty_grams, 21000);
  const manual = { ...row, current_qty: 500, current_qty_grams: 500, grams_per_inventory_unit: 1, inventory_uom: 'grams', match_method: 'manual_update' };
  assert.equal(context.withInventoryConversion(manual, 'bees wax', size).current_qty_grams, 500);
});

test('gram-based puck quantities are not multiplied; blue raspberry remains kilograms', () => {
  for (const [name, quantity] of [['Green Apple Pucks', 470088], ['Mango Pucks', 199955], ['Pineapple Pectin', 197575], ['Watermelon Pucks', 11112.5]]) {
    const raw = { uploaded_name: name, current_qty: quantity, quantity_uom: 'grams' };
    const fresh = context.withInventoryConversion(raw);
    assert.equal(fresh.current_qty_grams, quantity);
    const legacy = { ...raw, inventory_uom: 'Kilogram', grams_per_inventory_unit: 1000, current_qty_grams: quantity * 1000 };
    const repaired = context.withInventoryConversion(legacy);
    assert.equal(repaired.current_qty_grams, quantity);
    assert.equal(repaired.inventory_uom, 'Gram');
    assert.equal(context.withInventoryConversion(repaired).current_qty_grams, quantity);
  }
  assert.equal(context.withInventoryConversion({ uploaded_name: 'Blue Raspberry Pucks', current_qty: 270, quantity_uom: 'grams' }).current_qty_grams, 270000);
});

test('puck default repair preserves explicit corrections and manual gram totals', () => {
  const row = { uploaded_name: 'Mango Pucks', current_qty: 2, quantity_uom: 'grams', inventory_uom: 'Kilogram', grams_per_inventory_unit: 1000, current_qty_grams: 2000 };
  assert.equal(context.withInventoryConversion(row, 'Mango Pucks', { inventory_uom: 'Kilogram', grams_per_inventory_unit: 1000 }).current_qty_grams, 2000);
  assert.equal(context.withInventoryConversion({ ...row, inventory_uom: 'Custom box', grams_per_inventory_unit: 5000 }).current_qty_grams, 10000);
  assert.equal(context.withInventoryConversion({ ...row, match_method: 'manual_update', current_qty: 2000, current_qty_grams: 2000 }).current_qty_grams, 2000);
});
