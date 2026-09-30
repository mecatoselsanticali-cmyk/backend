import type { ISale, PaymentMethod } from "../../../models/Sale";
import type { IProduct } from "../../../models/Product";
import type { ISaleItemFiscalSnapshot } from "../../../models/Sale";

export interface FactusPaymentDetail {
  payment_form: "1";
  payment_method_code: string;
  reference_code: string;
  amount: string;
}

export interface FactusInvoicePayload {
  reference_code: string;
  document: "01";
  operation_type: "10";
  send_email: boolean;
  observation: string;
  numbering_range_id?: number;
  payment_details: FactusPaymentDetail[];
  customer: Record<string, string | string[]>;
  items: Array<{
    code_reference: string;
    name: string;
    quantity: string;
    discount_rate: string;
    price: string;
    unit_measure_code: string;
    standard_code: string;
    taxes: Array<{ is_excluded: true } | { code: string; rate: string }>;
  }>;
}

export interface FactusInvoiceMapperConfig {
  numberingRangeId?: number;
  sendEmail?: boolean;
}

/** Códigos de la tabla oficial Factus para facturas, decididos para cada método interno. */
export const FACTUS_PAYMENT_MAP: Record<PaymentMethod, FactusPaymentDetail["payment_method_code"]> = {
  CASH: "10",
  EFECTIVO: "10",
  NEQUI: "47",
  CARD: "49",
  DELIVERY_APP: "47",
  BANCOLOMBIA: "47",
};

const formatAmount = (value: number): string => Number(value).toFixed(2);

function mapCustomer(sale: ISale): { customer: FactusInvoicePayload["customer"] } | { error: string } {
  const customer = sale.customer;

  // Valores publicados en el ejemplo oficial de Factus para factura estándar
  // a consumidor final. Es distinto del ID genérico usado por Siigo.
  if (!customer?.document) {
    return {
      customer: {
        identification_document_code: "13",
        identification: "22222222222",
        names: "Consumidor Final",
      },
    };
  }

  if (!customer.identificationDocumentCode || !customer.legalOrganizationCode) {
    return {
      error: "La factura nominal requiere tipo de documento y tipo de persona del comprador",
    };
  }

  const identification = customer.document.trim();
  let identificationNumber = identification.replace(/[^\da-z]/gi, "");
  let dv: string | undefined;

  // Factus espera el NIT sin DV en `identification` y permite mandarlo
  // separado. Si el comprador lo escribió como NIT-DV, separamos el DV.
  if (customer.identificationDocumentCode === "31") {
    const nitWithDv = identification.replace(/\./g, "").match(/^(\d+)-([\dkK])$/);
    if (nitWithDv) {
      identificationNumber = nitWithDv[1];
      dv = nitWithDv[2].toUpperCase();
    } else {
      identificationNumber = identification.replace(/\D/g, "");
    }
  }

  const mappedCustomer: FactusInvoicePayload["customer"] = {
    identification_document_code: customer.identificationDocumentCode,
    identification: identificationNumber,
    legal_organization_code: customer.legalOrganizationCode,
  };

  if (dv) mappedCustomer.dv = dv;
  if (customer.legalOrganizationCode === "1") {
    mappedCustomer.company = customer.name?.trim() || "";
  } else {
    mappedCustomer.names = customer.name?.trim() || "";
  }
  if (customer.email?.trim()) mappedCustomer.email = customer.email.trim();

  if (!identificationNumber) {
    return { error: "El documento del comprador no contiene un número válido para Factus" };
  }
  if (!customer.name?.trim()) {
    return { error: "El comprador debe tener nombre o razón social para Factus" };
  }

  return { customer: mappedCustomer };
}

/**
 * Mapea una venta ya persistida al contrato Factus V2 sin llamadas de red.
 * Las líneas se marcan como excluidas según decisión explícita del negocio;
 * `Sale.tax` y los precios comerciales del POS no se modifican.
 */
export function buildFactusInvoicePayload(
  sale: ISale,
  products: Pick<
    IProduct,
    "_id" | "sku" | "unitMeasureCode" | "standardCode" | "isTaxExcluded" | "taxCode" | "taxRate"
  >[],
  config: FactusInvoiceMapperConfig = {}
): { payload: FactusInvoicePayload } | { error: string } {
  if (!sale.items.length) {
    return { error: "No se puede emitir una factura Factus sin productos" };
  }

  const customerResult = mapCustomer(sale);
  if ("error" in customerResult) return customerResult;

  const productsById = new Map(products.map((product) => [String(product._id), product]));
  const missingProduct = sale.items.find((item) => {
    const product = productsById.get(String(item.productId));
    return !item.fiscalSnapshot?.codeReference && !product?.sku;
  });
  if (missingProduct) {
    return {
      error: `El producto '${missingProduct.name}' (${missingProduct.productId}) no existe o no tiene SKU para Factus`,
    };
  }

  const missingTaxConfiguration = sale.items.find((item) => {
    const product = productsById.get(String(item.productId));
    const fiscal = item.fiscalSnapshot;
    const excluded = fiscal?.isTaxExcluded ?? product?.isTaxExcluded ?? true;
    const taxCode = fiscal?.taxCode ?? product?.taxCode;
    const taxRate = fiscal?.taxRate ?? product?.taxRate;
    return !excluded && (!taxCode || !Number.isFinite(taxRate));
  });
  if (missingTaxConfiguration) {
    return {
      error: `El producto '${missingTaxConfiguration.name}' no tiene una clasificación fiscal completa para Factus`,
    };
  }

  const paymentMethodCode = FACTUS_PAYMENT_MAP[sale.paymentMethod];
  if (!paymentMethodCode) {
    return { error: `No hay método de pago Factus configurado para '${sale.paymentMethod}'` };
  }

  const referenceCode = `SALE-${String(sale._id)}`;
  const payload: FactusInvoicePayload = {
    reference_code: referenceCode,
    document: "01",
    operation_type: "10",
    // Factus envía correos solo si se habilita explícitamente, para conservar
    // el comportamiento actual de Siigo (sin envío por defecto).
    send_email: config.sendEmail ?? false,
    observation: `Venta ${sale._id} - Mecatos el Santi`,
    payment_details: [
      {
        payment_form: "1",
        payment_method_code: paymentMethodCode,
        reference_code: referenceCode,
        amount: formatAmount(sale.total),
      },
    ],
    customer: customerResult.customer,
    items: sale.items.map((item) => {
      const product = productsById.get(String(item.productId));
      const fiscal: ISaleItemFiscalSnapshot | undefined = item.fiscalSnapshot;
      const isTaxExcluded = fiscal?.isTaxExcluded ?? product?.isTaxExcluded ?? true;
      const taxCode = fiscal?.taxCode ?? product?.taxCode;
      const taxRate = fiscal?.taxRate ?? product?.taxRate;
      const modifiersTotal = (item.modifiers || []).reduce(
        (total, modifier) => total + Number(modifier.extraPrice || 0),
        0
      );
      const unitPrice =
        Number.isFinite(item.subtotal) && item.quantity > 0
          ? item.subtotal / item.quantity
          : item.price + modifiersTotal;
      const modifierNames = (item.modifiers || []).map((modifier) => modifier.name).filter(Boolean);
      const name = modifierNames.length ? `${item.name} (${modifierNames.join(", ")})` : item.name;

      return {
        code_reference: fiscal?.codeReference || product!.sku,
        name,
        quantity: formatAmount(item.quantity),
        discount_rate: "0.00",
        price: formatAmount(unitPrice),
        unit_measure_code: fiscal?.unitMeasureCode || product?.unitMeasureCode || "94",
        standard_code: fiscal?.standardCode || product?.standardCode || "999",
        taxes: isTaxExcluded
          ? [{ is_excluded: true }]
          : [{ code: taxCode!, rate: formatAmount(taxRate!) }],
      };
    }),
  };

  if (config.numberingRangeId !== undefined) {
    payload.numbering_range_id = config.numberingRangeId;
  }

  return { payload };
}
