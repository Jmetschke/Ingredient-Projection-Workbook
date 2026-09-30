const GRAMS_PER_WEIGHT_UNIT = { g: 1, kg: 1000, lb: 453.59237, oz: 28.349523125 };

export function inventoryWeightConversion(input) {
  const weight = Number(input.package_weight);
  const factor = GRAMS_PER_WEIGHT_UNIT[input.weight_unit];
  const label = String(input.inventory_uom || '').trim();
  if (!label || label.length > 100) throw new Error('Enter a package/unit label (up to 100 characters).');
  if (!Number.isFinite(weight) || weight <= 0 || !factor || !Number.isFinite(weight * factor)) {
    throw new Error('Enter a positive package weight and select g, kg, lb, or oz.');
  }
  return {
    inventory_uom: label,
    package_weight: weight,
    weight_unit: input.weight_unit,
    grams_per_inventory_unit: weight * factor,
  };
}

// Report sizes do not alter source quantities. Prefer explicit manual settings,
// then remembered import corrections, current import metadata, and app defaults.
export function resolveInventoryPackageSize(ingredient, importOverrides, inventoryRows, defaultConversion) {
  const valid = size => Number(size?.grams_per_inventory_unit) > 0
    && Number.isFinite(Number(size.grams_per_inventory_unit)) && String(size.inventory_uom || '').trim();
  const result = (size, source) => ({
    inventory_uom: size.inventory_uom,
    package_weight: size.package_weight || Number(size.grams_per_inventory_unit),
    weight_unit: size.weight_unit || 'g',
    grams_per_inventory_unit: Number(size.grams_per_inventory_unit),
    package_size_source: source,
  });
  if (valid(ingredient)) return result(ingredient, 'manual');
  for (const [source, candidates] of [
    ['saved_import', importOverrides],
    ['import', inventoryRows.filter(row => !String(row.match_method || '').startsWith('manual_'))],
  ]) {
    const sizes = candidates.filter(size => String(size.ingredient_id) === String(ingredient.id) && valid(size));
    if (!sizes.length) continue;
    const keys = new Set(sizes.map(size => `${Number(size.grams_per_inventory_unit)}:${String(size.inventory_uom).trim().toLowerCase()}`));
    if (keys.size > 1) return { package_size_source: 'conflict' };
    return result(sizes[0], source);
  }
  return valid(defaultConversion) ? result(defaultConversion, 'default') : { package_size_source: 'unknown' };
}
