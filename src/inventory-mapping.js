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
