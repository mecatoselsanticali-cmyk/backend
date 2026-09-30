import type { ISale } from "../models/Sale";

export type ElectronicInvoiceProviderType = "MOCK" | "SIIGO" | "FACTUS";

export type InvoiceResultStatus = "SENT" | "APPROVED" | "REJECTED" | "PENDING";

/** Resultado normalizado de una emisión, independiente del PTA utilizado. */
export interface InvoiceResult {
  externalId?: string;
  referenceCode?: string;
  invoiceNumber?: string;
  cufe?: string;
  qrCodeUrl?: string;
  status: InvoiceResultStatus;
  providerStatus?: string;
  rawResponse?: unknown;
  error?: string;
}

/** Contrato que deben implementar los proveedores de factura electrónica. */
export interface ElectronicInvoiceProvider {
  issueInvoice(sale: ISale): Promise<InvoiceResult>;
}
