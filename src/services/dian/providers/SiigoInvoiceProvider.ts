import type { ISale } from "../../../models/Sale";
import type { IProduct } from "../../../models/Product";
import { Product } from "../../../models/Product";
import { Branch, IDianConfig } from "../../../models/Branch";
import { getTodayColombiaDateString } from "../../../utils/dateRange";
import type { ElectronicInvoiceProvider, InvoiceResult } from "../../../types/electronicInvoice";

const SIIGO_API_URL = "https://api.siigo.com";

// Token cacheado en memoria del proceso — Siigo no documenta una duración
// exacta, pero es un JWT de larga vida (horas), no algo pensado para
// pedirse en cada request. `SIIGO_TOKEN_TTL_MINUTES` (default 12h, con
// margen conservador) evita relogearse en cada venta procesada por el
// worker; si Siigo responde 401 con el token cacheado, issueInvoice limpia
// el cache y reintenta una vez con un token fresco.
let cachedSiigoToken: { token: string; expiresAt: number } | null = null;

/**
 * Autenticación contra Siigo. Se exporta para la prueba de integración
 * segura (`utils/testSiigoIntegration.ts`), que no crea facturas.
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
 * Mapa `Sale.paymentMethod` -> id de forma de pago en Siigo. Los ids son
 * específicos de la cuenta y se configuran con `SIIGO_PAYMENT_ID_*`.
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

/** Construye el payload de Siigo sin llamadas de red, para pruebas seguras. */
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

  const productsById = new Map(products.map((product) => [String(product._id), product]));
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
  // de CLAUDE.md): por defecto el payload omite taxes en cada ítem.
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

export class SiigoInvoiceProvider implements ElectronicInvoiceProvider {
  async issueInvoice(sale: ISale): Promise<InvoiceResult> {
    const [products, branch] = await Promise.all([
      Product.find({ _id: { $in: sale.items.map((item) => item.productId) } }, { siigoCode: 1 }),
      Branch.findById(sale.branchId, { dianConfig: 1 }),
    ]);

    const built = buildSiigoInvoicePayload(sale, products, branch?.dianConfig);
    if ("error" in built) {
      return { status: "REJECTED", error: built.error };
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

    // Token cacheado pudo expirar — un solo reintento con token fresco.
    if (response.status === 401) {
      token = await getSiigoAccessToken(true);
      response = await doRequest(token);
    }

    const body: any = await response.json().catch(() => null);

    if (!response.ok) {
      const error = (body && (body.Errors?.[0]?.Message || body.message)) || `Siigo respondió ${response.status}`;
      return { status: "REJECTED", error };
    }

    // `public_url` es el link al documento/QR de Siigo; `name` es el número
    // asignado a la factura. Ambos campos están verificados en producción.
    const qrCodeUrl = body?.public_url;
    const invoiceNumber = body?.name;
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

    // El POST ya creó la factura: no devolver REJECTED si el CUFE tarda,
    // porque BullMQ podría reintentar y crear otra factura real.
    if (!cufe) {
      console.warn(
        `[DianService] Factura Siigo ${invoiceId} creada para la venta ${sale._id} pero el CUFE no llegó tras ${pollAttempts} intentos — revisar manualmente en Siigo.`
      );
    }

    return {
      status: "APPROVED",
      externalId: invoiceId == null ? undefined : String(invoiceId),
      invoiceNumber,
      cufe,
      qrCodeUrl,
      providerStatus: body?.stamp?.status,
    };
  }
}
