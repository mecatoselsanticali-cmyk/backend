import type { ISale } from "../models/Sale";
import type { InvoiceResult } from "../types/electronicInvoice";
import {
  getInvoiceProvider,
  registerInvoiceProvider,
  resolveConfiguredInvoiceProvider,
} from "./dian/providers/providerResolver";
import { FactusInvoiceProvider } from "./dian/providers/FactusInvoiceProvider";
import { MockInvoiceProvider } from "./dian/providers/MockInvoiceProvider";
import { SiigoInvoiceProvider } from "./dian/providers/SiigoInvoiceProvider";

// Compatibilidad con `utils/testSiigoIntegration.ts` y cualquier consumidor
// existente de estas funciones. La implementación vive en el provider.
export { buildSiigoInvoicePayload, getSiigoAccessToken } from "./dian/providers/SiigoInvoiceProvider";
export type { SiigoInvoicePayload } from "./dian/providers/SiigoInvoiceProvider";
export type DianEmissionResult = InvoiceResult;

// El registro es local al proceso y no realiza llamadas de red.
registerInvoiceProvider("MOCK", new MockInvoiceProvider());
registerInvoiceProvider("SIIGO", new SiigoInvoiceProvider());
registerInvoiceProvider("FACTUS", new FactusInvoiceProvider());

class DianService {
  async emit(sale: ISale): Promise<InvoiceResult> {
    // Para ventas creadas antes del subdocumento, la primera reanudación usa
    // la configuración vigente y la persiste antes de tocar el PTA. Desde
    // ese momento, todos los reintentos quedan amarrados al mismo proveedor.
    if (!sale.electronicInvoice?.provider) {
      sale.electronicInvoice = {
        provider: resolveConfiguredInvoiceProvider(),
        attempts: sale.electronicInvoice?.attempts ?? 0,
      };
    }

    const providerName = sale.electronicInvoice.provider;
    sale.electronicInvoice.attempts = (sale.electronicInvoice.attempts || 0) + 1;
    sale.electronicInvoice.lastAttemptAt = new Date();
    sale.electronicInvoice.lastError = undefined;
    await sale.save();

    let result: InvoiceResult;
    try {
      result = await getInvoiceProvider(providerName).issueInvoice(sale);
    } catch (error) {
      sale.electronicInvoice.lastError = error instanceof Error ? error.message : String(error);
      await sale.save();
      throw error;
    }

    sale.electronicInvoice.externalId = result.externalId ?? sale.electronicInvoice.externalId;
    sale.electronicInvoice.referenceCode = result.referenceCode ?? sale.electronicInvoice.referenceCode;
    sale.electronicInvoice.providerStatus = result.providerStatus ?? sale.electronicInvoice.providerStatus;
    sale.electronicInvoice.lastError = result.error;
    // `rawResponse` no se persiste: no es necesario para el flujo y evita
    // almacenar PII o secretos que un proveedor pudiera incluir por error.
    await sale.save();

    return result;
  }

  /** Determina si requiere Factura Electrónica Nominal según el tope vigente. */
  requiresNominalInvoice(saleTotal: number): boolean {
    const tope = Number(process.env.DIAN_TOPE_CONSUMIDOR_FINAL) || 509000;
    return saleTotal > tope;
  }
}

export const dianService = new DianService();
