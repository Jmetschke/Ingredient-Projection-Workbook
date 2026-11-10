import test from 'node:test';
import assert from 'node:assert/strict';
import { receivedInventoryQuantity, manualInventoryChanges } from '../src/inventory-receiving.js';
test('receipts convert supported weight units and keep counts separate', () => {
  for (const [unit, total] of [['g',2],['kg',2000],['lb',907.18474],['oz',56.69904625]]) assert.equal(receivedInventoryQuantity(2,unit,'grams'),total);
  assert.equal(receivedInventoryQuantity(3,'each','each'),3);
  for (const [value,unit,type] of [[-1,'g','grams'],[0,'g','grams'],[Infinity,'kg','grams'],[1,'kg','each'],[1,'each','grams'],[1,'bad','grams']]) assert.throws(() => receivedInventoryQuantity(value,unit,type));
});
test('upload review checks only changed manual totals, aggregates aliases, and handles missing and unknown quantities', () => {
  const row = (id,qty,method='exact') => ({ingredient_id:id,ingredient_name:`Item ${id}`,current_qty_grams:qty,quantity_uom:'grams',match_method:method});
  const old = [row(1,100,'manual_add'),row(2,100),row(3,100,'manual_update'),row(4,100,'manual_add'),row(5,100,'manual_add'),{...row(6,100,'manual_add'),ignored_for_upload:1}];
  const next = [row(1,50),row(1,50),row(2,999),row(3,200),row(5,null)];
  const changes = manualInventoryChanges(old,next);
  assert.deepEqual(changes.map(r=>r.ingredient_id),[3,4,5]);
  assert.equal(changes[0].report_qty,200);
  assert.equal(changes[1].missing,true);
  assert.equal(changes[1].report_qty,0);
  assert.equal(changes[2].report_qty,null);
});
