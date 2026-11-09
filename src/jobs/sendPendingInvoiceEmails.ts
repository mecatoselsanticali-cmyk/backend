import { Sale } from "../models/Sale";
import { FactusInvoiceProvider } from "../services/dian/providers/FactusInvoiceProvider";

/** Outbox persistente independiente de DIAN: un fallo de correo nunca reemite la venta. */
export async function sendPendingInvoiceEmails(): Promise<void> {
  await Sale.updateMany({
    "electronicInvoice.emailStatus": "SENDING",
    "electronicInvoice.emailAttempts": { $gte: 5 },
    "electronicInvoice.emailNextAttemptAt": { $lte: new Date() },
  }, { $set: { "electronicInvoice.emailStatus": "FAILED", "electronicInvoice.emailLastError": "Se agotaron los intentos de envío" } });
  for (let index = 0; index < 10; index++) {
    // Reclamo atómico con lease: evita envíos simultáneos y permite recuperar reinicios.
    const sale = await Sale.findOneAndUpdate({
      dianStatus: "APPROVED",
      "electronicInvoice.provider": "FACTUS",
      "electronicInvoice.emailEnvironment": process.env.FACTUS_ENV || "sandbox",
      "electronicInvoice.emailStatus": { $in: ["PENDING", "SENDING"] },
      "electronicInvoice.emailNextAttemptAt": { $lte: new Date() },
      "electronicInvoice.emailAttempts": { $lt: 5 },
    }, {
      $set: { "electronicInvoice.emailStatus": "SENDING", "electronicInvoice.emailNextAttemptAt": new Date(Date.now() + 10 * 60_000) },
      $inc: { "electronicInvoice.emailAttempts": 1 },
    }, { new: true });
    if (!sale) return;
    const invoice = sale.electronicInvoice!;
    try {
      if (!invoice.emailInvoiceNumber || !sale.customer?.email?.trim()) throw new Error("Factura sin número o correo");
      await new FactusInvoiceProvider().sendEmail(invoice.emailInvoiceNumber, sale.customer.email.trim());
      await Sale.updateOne({ _id: sale._id }, {
        $set: { "electronicInvoice.emailStatus": "SENT" },
        $unset: { "electronicInvoice.emailLastError": 1 },
      });
    } catch (error) {
      await Sale.updateOne({ _id: sale._id }, { $set: {
        "electronicInvoice.emailStatus": invoice.emailAttempts! >= 5 ? "FAILED" : "PENDING",
        "electronicInvoice.emailLastError": error instanceof Error ? error.message : String(error),
        "electronicInvoice.emailNextAttemptAt": new Date(Date.now() + 30_000 * 2 ** invoice.emailAttempts!),
      } });
      console.error(`[InvoiceEmail] Falló el envío de la venta ${sale._id}`);
    }
  }
}
