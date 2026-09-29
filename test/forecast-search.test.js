import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('search and clear preserve forecast dates, settings, and row quantities', () => {
  const rows = [
    { ingredient_name: 'Sugar', ingredient_type: 'SB', required_qty: 12, starting_inventory_value: 40 },
    { ingredient_name: 'Flour', ingredient_type: 'SB', required_qty: 25, starting_inventory_value: 100 },
    { ingredient_name: 'Sugar syrup', ingredient_type: 'Hijnx', required_qty: 30 },
  ];
  const state = {
    forecastFilter: '', forecastIngredientType: 'SB', filter: '',
    forecastStart: '2026-10-01', forecastEnd: '2026-11-15', forecastWeeks: 7,
    forecastRows: rows, forecastInventoryAsOf: '2026-09-29',
  };
  const original = JSON.stringify(state);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', focus() {} });
    return elements.get(id);
  };
  // Unsaved date input values must also survive typing and clearing a search.
  element('#forecast-start').value = '2026-10-02';
  element('#forecast-end').value = '2026-11-16';
  const context = vm.createContext({
    state, document: { querySelector: element }, filterInput: element('#forecast-filter'),
    renderForecastSummary() {},
    table: (_headers, visible) => { context.visible = visible; return ''; },
  });
  vm.runInContext(source.slice(source.indexOf('function filteredRows('), source.indexOf('function forecastReportQuery(')), context);
  vm.runInContext(source.slice(source.indexOf('function forecastFilteredRows('), source.indexOf('function renderForecastSummary(')), context);
  vm.runInContext(source.slice(source.indexOf('  filterInput.value = state.forecastFilter;'), source.indexOf('  typeSelect.value = state.forecastIngredientType;')), context);
  element('#forecast-filter').value = '  SUGAR  ';
  element('#forecast-filter').oninput();
  assert.equal(context.visible.length, 1);
  assert.equal(context.visible[0], rows[0]);
  assert.equal(element('#forecast-search-results').textContent, 'Showing 1 of 3 inventory items');
  element('#forecast-clear-search').onclick();
  assert.equal(context.visible.length, 2);
  assert.equal(JSON.stringify(state), original);
  assert.equal(element('#forecast-start').value, '2026-10-02');
  assert.equal(element('#forecast-end').value, '2026-11-16');
});
