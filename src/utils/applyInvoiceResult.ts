import type { ISale } from "../models/Sale";
import type { InvoiceResult } from "../types/electronicInvoice";

/** Copia el resultado normalizado al estado común visible del Sale. */
export function applyInvoiceResult(sale: ISale, result: InvoiceResult): void {
  sale.dianStatus = result.status;
  if (result.cufe !== undefined) sale.cufe = result.cufe;
  if (result.qrCodeUrl !== undefined) sale.qrCodeUrl = result.qrCodeUrl;
  if (result.invoiceNumber !== undefined) sale.dianInvoiceNumber = result.invoiceNumber;
}
