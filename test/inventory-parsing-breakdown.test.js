import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const context = vm.createContext({});
const escapeStart = source.indexOf('function escapeHtml(');
vm.runInContext(source.slice(escapeStart, source.indexOf('\nfunction ', escapeStart + 1)), context);
vm.runInContext(source.slice(source.indexOf('function inventoryParsingBreakdown('), source.indexOf('function inventoryMappingNeedsReview(')), context);
const row = { uploaded_name: 'Mango Pucks', ingredient_id: 1, ingredient_name: 'Mango Pucks', ingredient_type: 'Hijnx', source_qty: 199955, current_qty: 199955, current_qty_grams: 199955, quantity_uom: 'grams', inventory_uom: 'Gram', grams_per_inventory_unit: 1, match_method: 'exact' };

test('breakdown shows source count separately from corrected calculation and saved weight', () => {
  const html = context.inventoryParsingBreakdown({ ...row, source_qty: 0.62, current_qty: 0.5, grams_per_inventory_unit: 3500, current_qty_grams: 1750, unit_override: { package_weight: 3.5 } });
  assert.match(html, /PDF quantity: 0\.62/);
  assert.match(html, /0\.5 × 3,500 g per source unit = 1,750 g/);
  assert.match(html, /Saved package\/unit correction/);
  assert.match(html, /1,750 g contributes/);
});

test('breakdown preserves zero, unknown weights, ignored status, and unmatched status', () => {
  assert.match(context.inventoryParsingBreakdown({ ...row, source_qty: 0, current_qty: 0, current_qty_grams: 0 }), /0 × 1 g per source unit = 0 g/);
  const missing = context.inventoryParsingBreakdown({ ...row, grams_per_inventory_unit: null, current_qty_grams: null, source_qty: null });
  assert.match(missing, /total grams unknown/);
  assert.match(missing, /Original PDF quantity was not recorded/);
  assert.doesNotMatch(missing, /= 0 g/);
  assert.match(context.inventoryParsingBreakdown({ ...row, ignored_for_upload: 1 }), /Excluded: ignored/);
  assert.match(context.inventoryParsingBreakdown({ ...row, ingredient_id: null }), /Not assigned to a master ingredient/);
});

test('count and manual entries do not claim a second weight conversion, and text is escaped', () => {
  const each = context.inventoryParsingBreakdown({ ...row, quantity_uom: 'each', current_qty: 800, source_qty: 1 });
  assert.match(each, /800 each is the current stored count/);
  assert.doesNotMatch(each, /×/);
  assert.match(context.inventoryParsingBreakdown({ ...row, match_method: 'manual_update' }), /entered directly; no package multiplication/);
  const html = context.inventoryParsingBreakdown({ ...row, uploaded_name: '<img src=x onerror=alert(1)>', inventory_uom: '<script>' });
  assert.doesNotMatch(html, /<img|<script>/);
  assert.match(html, /&lt;img/);
});
