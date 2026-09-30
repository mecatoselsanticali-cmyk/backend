import type { ISaleItemFiscalSnapshot } from "../models/Sale";

export interface FiscalProductSource {
  sku?: string;
  unitMeasureCode?: string;
  standardCode?: string;
  isTaxExcluded?: boolean;
  taxCode?: string;
  taxRate?: number;
}

/** Captura los códigos vigentes del producto dentro de una nueva venta. */
export function buildSaleItemFiscalSnapshot(
  product: FiscalProductSource
): ISaleItemFiscalSnapshot | undefined {
  const codeReference = product.sku?.trim();
  if (!codeReference) return undefined;

  return {
    codeReference,
    unitMeasureCode: product.unitMeasureCode?.trim() || "94",
    standardCode: product.standardCode?.trim() || "999",
    isTaxExcluded: product.isTaxExcluded ?? true,
    taxCode: product.taxCode,
    taxRate: product.taxRate,
  };
}
