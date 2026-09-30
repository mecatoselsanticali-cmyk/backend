import crypto from "crypto";
import type { ISale } from "../../../models/Sale";
import type { ElectronicInvoiceProvider, InvoiceResult } from "../../../types/electronicInvoice";

/** Simulador local; no realiza llamadas a un proveedor tecnológico. */
export class MockInvoiceProvider implements ElectronicInvoiceProvider {
  async issueInvoice(sale: ISale): Promise<InvoiceResult> {
    await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 600));

    if (Math.random() < 0.05) {
      return { status: "REJECTED", error: "Timeout simulado del proveedor DIAN" };
    }

    const cufe = crypto
      .createHash("sha256")
      .update(`${sale._id}-${sale.total}-${Date.now()}`)
      .digest("hex");

    return {
      status: "APPROVED",
      cufe,
      qrCodeUrl: `https://mock-dian.local/qr/${cufe}`,
      invoiceNumber: `FV-MOCK-${String(sale._id).slice(-4).toUpperCase()}`,
      providerStatus: "MOCK_APPROVED",
    };
  }
}
