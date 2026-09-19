import crypto from "crypto";
import { ISale } from "../models/Sale";
import { IProduct, Product } from "../models/Product";
import { Branch, IDianConfig } from "../models/Branch";
import { getTodayColombiaDateString } from "../utils/dateRange";

export interface DianEmissionResult {
  status: "APPROVED" | "REJECTED";
  cufe?: string;
  qrCodeUrl?: string;
  // Número real de factura asignado por el PTA (ej. "FV-3-7" en Siigo,
  // campo `name` de su respuesta) — ver punto 34/receipt redesign en
  // backend/CLAUDE.md.
  invoiceNumber?: string;
  errorMessage?: string;
}

const SIIGO_API_URL = "https://api.siigo.com";

// Token cacheado en memoria del proceso — Siigo no documenta una duración
// exacta, pero es un JWT de larga vida (horas), no algo pensado para
// pedirse en cada request. `SIIGO_TOKEN_TTL_MINUTES` (default 12h, con
// margen conservador) evita relogearse en cada venta procesada por el
// worker; si Siigo responde 401 con un token cacheado, `siigoEmit` limpia
// el cache y reintenta una vez con un token fresco (ver abajo).
let cachedSiigoToken: { token: string; expiresAt: number } | null = null;

/**
 * Autenticación contra Siigo. Standalone (no depende de `DianService`) para
 * poder probarse de forma aislada (ver `utils/testSiigoIntegration.ts`) sin
 * pasar por el resto del flujo de emisión.
 */
export async function getSiigoAccessToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedSiigoToken && cachedSiigoToken.expiresAt > Date.now()) {
    return cachedSiigoToken.token;
  }

  const response = await fetch(`${SIIGO_API_URL}/auth`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Partner-Id": process.env.SIIGO_PARTNER_ID || "",
    },
    body: JSON.stringify({
      username: process.env.SIIGO_USERNAME,
      access_key: process.env.SIIGO_ACCESS_KEY,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Siigo /auth respondió ${response.status}: ${body}`);
  }

  const data = (await response.json()) as { access_token: string };
  const ttlMinutes = Number(process.env.SIIGO_TOKEN_TTL_MINUTES) || 12 * 60;
  cachedSiigoToken = {
    token: data.access_token,
    expiresAt: Date.now() + ttlMinutes * 60 * 1000,
  };
  return cachedSiigoToken.token;
}

/**
 * Mapa `Sale.paymentMethod` -> id de forma de pago en Siigo. Cada valor
 * viene de una variable de entorno (`SIIGO_PAYMENT_ID_<METODO>`) porque los
 * ids son específicos de la cuenta de Siigo del negocio (se obtienen de
 * `GET /v1/payment-types`, ver `siigo_test`) — no hay un id universal que
 * sirva de default razonable. Si falta el mapeo para el método de la venta,
 * `buildSiigoInvoicePayload` rechaza explícitamente en vez de adivinar.
 */
function resolveSiigoPaymentId(paymentMethod: ISale["paymentMethod"]): string | undefined {
  const envVar = `SIIGO_PAYMENT_ID_${paymentMethod}`;
  return process.env[envVar];
}

export interface SiigoInvoicePayload {
  document: { id: number };
  date: string;
  customer: { identification: string; branch_office: number };
  seller: number;
  items: Array<{
    code: string;
    quantity: number;
    price: number;
    taxes: Array<{ id: number }>;
  }>;
  payments: Array<{ id: number; value: number }>;
  observations: string;
  stamp: { send: boolean };
  mail: { send: boolean };
}

/**
 * Construye el payload de factura de Siigo a partir de una `Sale` ya
 * guardada + los `Product` de sus items (para resolver `siigoCode`). Función
 * pura y exportada a propósito (sin llamadas de red) para poder probar el
 * mapeo de datos sin arriesgar una emisión real contra Siigo — ver
 * `utils/testSiigoIntegration.ts`.
 *
 * Devuelve `{ error }` (nunca lanza) ante cualquier dato faltante — esto se
 * traduce 1:1 a un `REJECTED` con mensaje claro en `siigoEmit`, que por
 * diseño NO se reintenta automáticamente (ver punto 3 de CLAUDE.md): un
 * producto sin `siigoCode`, una sede sin `siigoSellerId`/`siigoDocumentId`,
 * o un método de pago sin mapear son problemas de configuración, no de
 * infraestructura — reintentar solo no los arregla, alguien tiene que
 * completar el mapeo y reencolar a mano.
 *
 * `seller`/`document.id` salen de `branch.dianConfig`, NO de una variable de
 * entorno global — la cuenta de Siigo tiene un vendedor y una resolución de
 * facturación electrónica distintos por sede/punto de venta (confirmado
 * contra la cuenta real con `npm run test:siigo`: existen usuarios Siigo
 * "Boulevard"/"Centrosur"/"Holguines", uno por sede).
 */
export function buildSiigoInvoicePayload(
  sale: Pick<ISale, "_id" | "items" | "paymentMethod" | "total" | "customer">,
  products: Pick<IProduct, "_id" | "siigoCode">[],
  branchDianConfig: Pick<IDianConfig, "siigoSellerId" | "siigoDocumentId"> | undefined
): { payload: SiigoInvoicePayload } | { error: string } {
  const documentId = branchDianConfig?.siigoDocumentId;
  if (!documentId) {
    return { error: "La sede de esta venta no tiene siigoDocumentId configurado (Branch.dianConfig)" };
  }

  const sellerId = branchDianConfig?.siigoSellerId;
  if (!sellerId) {
    return { error: "La sede de esta venta no tiene siigoSellerId configurado (Branch.dianConfig)" };
  }

  const paymentTypeId = resolveSiigoPaymentId(sale.paymentMethod);
  if (!paymentTypeId) {
    return {
      error: `No hay id de Siigo configurado para el método de pago '${sale.paymentMethod}' (falta SIIGO_PAYMENT_ID_${sale.paymentMethod})`,
    };
  }

  const productsById = new Map(products.map((p) => [String(p._id), p]));
  const missingCode = sale.items.find((item) => {
    const product = productsById.get(String(item.productId));
    return !product?.siigoCode;
  });
  if (missingCode) {
    return {
      error: `El producto '${missingCode.name}' (${missingCode.productId}) no tiene siigoCode configurado`,
    };
  }

  // El negocio no declara/cobra impuestos (Sale.tax siempre 0, ver punto 65
  // de CLAUDE.md) — a diferencia del payload de prueba de siigo_test (que
  // sí armaba `taxes: [{ id: 256 }]`, un 8% de Impoconsumo), acá se manda
  // `taxes: []` por default para no declarar un impuesto que el negocio no
  // cobra en el ticket. `SIIGO_ITEM_TAX_ID` queda disponible si el negocio
  // decide más adelante empezar a declarar Impoconsumo a través de Siigo.
  const taxId = Number(process.env.SIIGO_ITEM_TAX_ID) || undefined;

  const payload: SiigoInvoicePayload = {
    document: { id: documentId },
    date: getTodayColombiaDateString(),
    customer: {
      identification: sale.customer?.document || process.env.SIIGO_DEFAULT_CUSTOMER_ID || "222222222222",
      branch_office: 0,
    },
    seller: sellerId,
    items: sale.items.map((item) => ({
      code: productsById.get(String(item.productId))!.siigoCode!,
      quantity: item.quantity,
      price: item.price,
      taxes: taxId ? [{ id: taxId }] : [],
    })),
    payments: [{ id: Number(paymentTypeId), value: sale.total }],
    observations: `Venta ${sale._id} - Mecatos el Santi`,
    stamp: { send: true },
    mail: { send: process.env.SIIGO_INVOICE_SEND_MAIL === "true" },
  };

  return { payload };
}

/**
 * Punto único de integración con el PTA (Proveedor Tecnológico Autorizado).
 * `DIAN_PROVIDER=MOCK` (default) simula el proveedor; `DIAN_PROVIDER=SIIGO`
 * llama a la API real de Siigo. Cambiar de proveedor es tocar solo este
 * archivo — el worker, la cola y los controladores no saben qué proveedor
 * está detrás (ver punto 10 de CLAUDE.md).
 */
class DianService {
  private mode = process.env.DIAN_PROVIDER || "MOCK";

  async emit(sale: ISale): Promise<DianEmissionResult> {
    if (this.mode === "MOCK") {
      return this.mockEmit(sale);
    }

    if (this.mode === "SIIGO") {
      return this.siigoEmit(sale);
    }

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
      // Formato "FV-<doc>-<consecutivo>" solo para que el recibo tenga algo
      // que mostrar en dev sin depender de Siigo real — no es un número
      // real de ningún lado.
      invoiceNumber: `FV-MOCK-${String(sale._id).slice(-4).toUpperCase()}`,
    };
  }

  private async siigoEmit(sale: ISale): Promise<DianEmissionResult> {
    const [products, branch] = await Promise.all([
      Product.find({ _id: { $in: sale.items.map((item) => item.productId) } }, { siigoCode: 1 }),
      Branch.findById(sale.branchId, { dianConfig: 1 }),
    ]);

    const built = buildSiigoInvoicePayload(sale, products, branch?.dianConfig);
    if ("error" in built) {
      return { status: "REJECTED", errorMessage: built.error };
    }

    const doRequest = async (token: string) =>
      fetch(`${SIIGO_API_URL}/v1/invoices`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Partner-Id": process.env.SIIGO_PARTNER_ID || "",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(built.payload),
      });

    let token = await getSiigoAccessToken();
    let response = await doRequest(token);

    // Token cacheado pudo expirar entre la última llamada y esta — un solo
    // reintento con un token fresco antes de rendirse.
    if (response.status === 401) {
      token = await getSiigoAccessToken(true);
      response = await doRequest(token);
    }

    const body: any = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMessage =
        (body && (body.Errors?.[0]?.Message || body.message)) || `Siigo respondió ${response.status}`;
      return { status: "REJECTED", errorMessage };
    }

    // `public_url` (confirmado contra una respuesta real — ver punto 10 de
    // backend/CLAUDE.md) es el link de Siigo al documento/QR de la factura.
    // NO es `stamp.qr_code` ni `stamp.pdf.file_url` — esos dos campos no
    // existen en la respuesta real, eran una suposición sin verificar.
    const qrCodeUrl = body?.public_url;
    // `name` (ej. "FV-3-7") es el número real de factura que Siigo asigna
    // — viene en la respuesta inicial del POST, no hace falta esperar el
    // poll del CUFE para tenerlo.
    const invoiceNumber = body?.name;

    // El timbrado de Siigo es ASÍNCRONO: el POST puede responder OK antes de
    // que DIAN termine de confirmar el CUFE — confirmado con una factura
    // real donde `stamp.cufe` venía vacío en la respuesta del POST pese a
    // que la factura sí se había creado bien (visible después con
    // `GET /v1/invoices/:id`). Por eso se reconsulta la factura por su id
    // hasta `SIIGO_STAMP_POLL_ATTEMPTS` veces (default 5, cada
    // `SIIGO_STAMP_POLL_DELAY_MS` ms, default 2000 — ~10s en total) antes de
    // darse por vencido.
    let cufe: string | undefined = body?.stamp?.cufe;
    const invoiceId = body?.id;
    const pollAttempts = Number(process.env.SIIGO_STAMP_POLL_ATTEMPTS) || 5;
    const pollDelayMs = Number(process.env.SIIGO_STAMP_POLL_DELAY_MS) || 2000;

    for (let attempt = 0; !cufe && invoiceId && attempt < pollAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
      const pollToken = await getSiigoAccessToken();
      const pollResponse = await fetch(`${SIIGO_API_URL}/v1/invoices/${invoiceId}`, {
        headers: {
          Authorization: `Bearer ${pollToken}`,
          "Partner-Id": process.env.SIIGO_PARTNER_ID || "",
          "Content-Type": "application/json",
        },
      });
      if (pollResponse.ok) {
        const pollBody: any = await pollResponse.json().catch(() => null);
        cufe = pollBody?.stamp?.cufe;
      }
    }

    // La factura YA está creada/timbrada en Siigo llegados a este punto — si
    // el CUFE sigue sin aparecer tras el poll, no tiene sentido devolver
    // REJECTED (eso implicaría reintentar y crear una SEGUNDA factura real
    // por la misma venta). Se deja `cufe` vacío con un warning para revisión
    // manual en vez de eso.
    if (!cufe) {
      console.warn(
        `[DianService] Factura Siigo ${invoiceId} creada para la venta ${sale._id} pero el CUFE no llegó tras ${pollAttempts} intentos — revisar manualmente en Siigo.`
      );
    }

    return { status: "APPROVED", cufe, qrCodeUrl, invoiceNumber };
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
