export function receivedInventoryQuantity(value, unit, recipeUnit) {
  const factors = { g: 1, kg: 1000, lb: 453.59237, oz: 28.349523125 };
  const factor = recipeUnit === 'each' ? (unit === 'each' ? 1 : undefined) : factors[unit];
  const quantity = Number(value);
  if (!factor || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(quantity * factor)) {
    throw new Error('Enter a positive quantity and a unit appropriate for this ingredient.');
  }
  return quantity * factor;
}

export function manualInventoryChanges(existing, incoming) {
  const ids = new Set(existing.filter(row => !row.ignored_for_upload && String(row.match_method).startsWith('manual_')).map(row => row.ingredient_id));
  return [...ids].map(id => {
    const before = existing.filter(row => !row.ignored_for_upload && row.ingredient_id === id);
    const after = incoming.filter(row => !row.ignored_for_upload && row.ingredient_id === id);
    const unit = before[0].quantity_uom === 'each' ? 'each' : 'g';
    const total = rows => rows.some(row => (unit === 'each' ? row.current_qty : row.current_qty_grams) == null) ? null
      : rows.reduce((sum, row) => sum + Number(unit === 'each' ? row.current_qty : row.current_qty_grams), 0);
    return { ingredient_id: id, name: before[0].ingredient_name || before[0].uploaded_name,
      previous_qty: total(before), report_qty: total(after), unit, missing: !after.length };
  }).filter(row => row.report_qty == null || row.previous_qty !== row.report_qty);
}
