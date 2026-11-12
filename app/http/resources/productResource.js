// Explicit key lists: only these fields reach the API, so cost data and stock internals cannot leak.

/** One result of GET /api/v1/products. */
export function productResource(item) {
  return {
    id: item.id,
    sku: item.sku,
    name: item.name,
    genericName: item.genericName,
    strength: item.strength,
    dosageForm: item.dosageForm,
    classification: item.classification,
    requiresPrescription: item.requiresPrescription,
    availableBaseQuantity: item.availableBaseQuantity,
    matchedUnitId: item.matchedUnitId,
    units: item.units.map((unit) => {
      return {
        productUnitId: unit.productUnitId,
        name: unit.name,
        abbreviation: unit.abbreviation,
        conversionFactor: unit.conversionFactor,
        price: unit.price,
        barcodes: [...unit.barcodes],
      };
    }),
  };
}
