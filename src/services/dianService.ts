import crypto from "crypto";
import { ISale } from "../models/Sale";

export interface DianEmissionResult {
  status: "APPROVED" | "REJECTED";
  cufe?: string;
  qrCodeUrl?: string;
  errorMessage?: string;
}

/**
 * Punto único de integración con el PTA (Proveedor Tecnológico Autorizado).
 * Actualmente en modo MOCK. Cuando haya credenciales reales, reemplazar el
 * cuerpo de `emit()` por la llamada HTTP real (Factus / Alegra / Siigo)
 * manteniendo la misma interfaz para no tocar el resto del sistema.
 */
class DianService {
  private mode = process.env.DIAN_PROVIDER || "MOCK";

  async emit(sale: ISale): Promise<DianEmissionResult> {
    if (this.mode === "MOCK") {
      return this.mockEmit(sale);
    }

    // TODO: integración real con el PTA configurado (DIAN_API_URL / DIAN_API_KEY)
    // const response = await axios.post(`${process.env.DIAN_API_URL}/invoices`, payload, {
    //   headers: { Authorization: `Bearer ${process.env.DIAN_API_KEY}` },
    // });
    throw new Error(`Proveedor DIAN '${this.mode}' no implementado todavía`);
  }

  private async mockEmit(sale: ISale): Promise<DianEmissionResult> {
    // Simula latencia de red del proveedor
    await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 600));

    // Simula un pequeño porcentaje de fallos para probar el reintento (Exponential Backoff)
    const shouldFail = Math.random() < 0.05;
    if (shouldFail) {
      return { status: "REJECTED", errorMessage: "Timeout simulado del proveedor DIAN" };
    }

    const cufe = crypto
      .createHash("sha256")
      .update(`${sale._id}-${sale.total}-${Date.now()}`)
      .digest("hex");

    return {
      status: "APPROVED",
      cufe,
      qrCodeUrl: `https://mock-dian.local/qr/${cufe}`,
    };
  }

  /**
   * Determina si una venta debe emitirse como Documento POS Electrónico
   * o como Factura Electrónica Nominal, según el tope diario/UVT (REQ-10).
   */
  requiresNominalInvoice(saleTotal: number): boolean {
    const tope = Number(process.env.DIAN_TOPE_CONSUMIDOR_FINAL) || 509000;
    return saleTotal > tope;
  }
}

export const dianService = new DianService();
