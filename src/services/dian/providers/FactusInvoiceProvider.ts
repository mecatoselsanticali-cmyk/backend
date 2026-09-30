import type { ISale } from "../../../models/Sale";
import { Product } from "../../../models/Product";
import type { ElectronicInvoiceProvider, InvoiceResult } from "../../../types/electronicInvoice";
import { buildFactusInvoicePayload } from "./FactusInvoiceMapper";

const MAX_429_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_SKEW_MS = 30_000;

interface FactusTokenCache {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

class FactusApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "FactusApiError";
  }
}

let tokenCache: FactusTokenCache | null = null;
let tokenRequest: Promise<FactusTokenCache> | null = null;

function getFactusBaseUrl(): string {
  const environment = (process.env.FACTUS_ENV || "sandbox").trim().toLowerCase();
  if (environment === "sandbox") return "https://api-sandbox.factus.com.co";
  if (environment === "production") return "https://api.factus.com.co";
  throw new Error("FACTUS_ENV debe ser 'sandbox' o 'production'");
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const retryAt = Date.parse(header);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : undefined;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRateLimit(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status !== 429 || attempt >= MAX_429_RETRIES) return response;

    const delay = retryAfterMs(response.headers.get("Retry-After")) ?? 1000 * 2 ** attempt;
    await wait(delay);
  }
}

async function responseBody(response: Response): Promise<any> {
  const rawBody = await response.text().catch(() => "");
  if (!rawBody) return {};
  try {
    return JSON.parse(rawBody);
  } catch {
    return { message: rawBody };
  }
}

function errorMessage(body: any, fallback: string): string {
  if (typeof body?.message === "string" && body.message.trim()) return body.message;
  if (typeof body?.error === "string" && body.error.trim()) return body.error;
  if (body?.errors && typeof body.errors === "object") {
    const messages = Object.values(body.errors)
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .filter((value): value is string => typeof value === "string");
    if (messages.length) return messages.join("; ");
  }
  return fallback;
}

async function requestTokenGrant(
  grant: "password" | "refresh_token",
  existingToken?: FactusTokenCache
): Promise<FactusTokenCache> {
  const form = new URLSearchParams({
    grant_type: grant,
    client_id: process.env.FACTUS_CLIENT_ID || "",
    client_secret: process.env.FACTUS_CLIENT_SECRET || "",
  });

  if (grant === "password") {
    form.set("username", process.env.FACTUS_USERNAME || "");
    form.set("password", process.env.FACTUS_PASSWORD || "");
  } else {
    if (!existingToken?.refreshToken) throw new Error("Factus no entregó refresh_token");
    form.set("refresh_token", existingToken.refreshToken);
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (grant === "refresh_token" && existingToken?.accessToken) {
    headers.Authorization = `Bearer ${existingToken.accessToken}`;
  }

  const response = await fetchWithRateLimit(`${getFactusBaseUrl()}/oauth/token`, {
    method: "POST",
    headers,
    body: form.toString(),
  });
  const body = await responseBody(response);

  if (!response.ok) {
    throw new FactusApiError(errorMessage(body, `Factus OAuth respondió ${response.status}`), response.status);
  }
  if (typeof body?.access_token !== "string" || !body.access_token) {
    throw new Error("Factus OAuth no devolvió access_token");
  }

  const expiresInSeconds = Number(body.expires_in);
  const expiresIn = Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : existingToken?.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

async function getFactusAccessToken(forceRefresh = false): Promise<string> {
  if (
    !forceRefresh &&
    tokenCache &&
    Date.now() < tokenCache.expiresAt - TOKEN_REFRESH_SKEW_MS
  ) {
    return tokenCache.accessToken;
  }

  if (!tokenRequest) {
    tokenRequest = (async () => {
      if (tokenCache?.refreshToken) {
        try {
          return await requestTokenGrant("refresh_token", tokenCache);
        } catch (error) {
          // Refresh token vencido/revocado: solo en 400/401 se intenta
          // autenticar de nuevo con credenciales; fallos transitorios se
          // propagan para que BullMQ los reintente.
          if (!(error instanceof FactusApiError) || ![400, 401].includes(error.status || 0)) {
            throw error;
          }
        }
      }
      return requestTokenGrant("password", tokenCache || undefined);
    })();
  }

  try {
    tokenCache = await tokenRequest;
    return tokenCache.accessToken;
  } finally {
    tokenRequest = null;
  }
}

async function authorizedRequest(path: string, init: RequestInit): Promise<Response> {
  const url = `${getFactusBaseUrl()}${path}`;
  let token = await getFactusAccessToken();

  const send = (accessToken: string) =>
    fetchWithRateLimit(url, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${accessToken}`,
      },
    });

  let response = await send(token);
  if (response.status === 401) {
    token = await getFactusAccessToken(true);
    response = await send(token);
  }
  return response;
}

function normalizeFactusResult(body: any, fallbackReference: string): InvoiceResult {
  const data = body?.data?.bill || body?.data;
  if (!data || typeof data !== "object") {
    return {
      status: "PENDING",
      referenceCode: fallbackReference,
      providerStatus: "UNKNOWN_RESPONSE",
      error: "Factus aceptó la solicitud pero no devolvió los datos de la factura; revisar por reference_code",
    };
  }

  const isValidated = data.is_validated === true || data.is_validated === 1;
  const links = data.links || {};
  return {
    externalId: data.id == null ? undefined : String(data.id),
    referenceCode: typeof data.reference_code === "string" ? data.reference_code : fallbackReference,
    invoiceNumber: typeof data.number === "string" ? data.number : undefined,
    cufe: typeof data.cufe === "string" ? data.cufe : undefined,
    qrCodeUrl:
      typeof links.qr === "string"
        ? links.qr
        : typeof links.public_url === "string"
          ? links.public_url
          : undefined,
    status: isValidated ? "APPROVED" : "PENDING",
    providerStatus:
      typeof data.status === "string"
        ? data.status
        : isValidated
          ? "VALIDATED"
          : "PENDING_VALIDATION",
  };
}

function findInvoiceRecords(body: any): any[] {
  if (Array.isArray(body?.data?.data)) return body.data.data;
  if (Array.isArray(body?.data)) return body.data;
  if (Array.isArray(body?.data?.bills)) return body.data.bills;
  return [];
}

export class FactusInvoiceProvider implements ElectronicInvoiceProvider {
  async issueInvoice(sale: ISale): Promise<InvoiceResult> {
    try {
      getFactusBaseUrl();
    } catch (error) {
      return { status: "REJECTED", error: (error as Error).message };
    }

    const missingCredentials = [
      "FACTUS_CLIENT_ID",
      "FACTUS_CLIENT_SECRET",
      "FACTUS_USERNAME",
      "FACTUS_PASSWORD",
    ].filter((key) => !process.env[key]?.trim());
    if (missingCredentials.length) {
      return {
        status: "REJECTED",
        error: `Faltan credenciales Factus en el backend: ${missingCredentials.join(", ")}`,
      };
    }

    const numberingRangeRaw = process.env.FACTUS_NUMBERING_RANGE_ID?.trim();
    const numberingRangeId = numberingRangeRaw ? Number(numberingRangeRaw) : undefined;
    if (numberingRangeRaw && (!Number.isInteger(numberingRangeId) || Number(numberingRangeId) <= 0)) {
      return { status: "REJECTED", error: "FACTUS_NUMBERING_RANGE_ID debe ser un entero positivo" };
    }

    const productsNeedingFallback = sale.items.filter((item) => !item.fiscalSnapshot);
    const products = productsNeedingFallback.length
      ? await Product.find(
          { _id: { $in: productsNeedingFallback.map((item) => item.productId) } },
          { sku: 1, unitMeasureCode: 1, standardCode: 1, isTaxExcluded: 1, taxCode: 1, taxRate: 1 }
        )
      : [];
    const built = buildFactusInvoicePayload(sale, products, {
      numberingRangeId,
      sendEmail: process.env.FACTUS_SEND_EMAIL === "true" && Boolean(sale.customer?.email),
    });
    if ("error" in built) return { status: "REJECTED", error: built.error };

    const path = "/v2/bills/validate";
    try {
      await getFactusAccessToken();
    } catch (error) {
      if (error instanceof FactusApiError && [400, 401, 403].includes(error.status || 0)) {
        return { status: "REJECTED", referenceCode: built.payload.reference_code, error: error.message };
      }
      throw error;
    }

    let response: Response;
    try {
      response = await authorizedRequest(path, {
        method: "POST",
        body: JSON.stringify(built.payload),
      });
    } catch (error) {
      // Una desconexión/timeout al enviar puede ocurrir después de que Factus
      // haya registrado la factura. Tratar el resultado como incierto permite
      // reconciliar por el mismo reference_code, sin degradar SPECIAL ni
      // intentar crearla con otro provider.
      if (error instanceof FactusApiError && [400, 401, 403].includes(error.status || 0)) {
        return { status: "REJECTED", referenceCode: built.payload.reference_code, error: error.message };
      }
      return {
        status: "PENDING",
        referenceCode: built.payload.reference_code,
        providerStatus: "REQUEST_OUTCOME_UNKNOWN",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const body = await responseBody(response);

    if (response.ok) return normalizeFactusResult(body, built.payload.reference_code);

    // Un timeout del cliente puede ocurrir después de que Factus haya creado
    // la factura. El reference_code determinístico evita crear otra y esta
    // consulta recupera el resultado ya registrado en Factus.
    if ([409, 422].includes(response.status)) {
      try {
        const existing = await this.findByReferenceCode(built.payload.reference_code);
        if (existing) return normalizeFactusResult({ data: existing }, built.payload.reference_code);
      } catch (error) {
        return {
          status: "PENDING",
          referenceCode: built.payload.reference_code,
          providerStatus: "REFERENCE_LOOKUP_PENDING",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const message = errorMessage(body, `Factus respondió ${response.status}`);
    if (response.status === 429 || response.status >= 500) {
      return {
        status: "PENDING",
        referenceCode: built.payload.reference_code,
        providerStatus: `HTTP_${response.status}`,
        error: message,
      };
    }

    return { status: "REJECTED", referenceCode: built.payload.reference_code, error: message };
  }

  private async findByReferenceCode(referenceCode: string): Promise<any | undefined> {
    const query = new URLSearchParams({ "filter[reference_code]": referenceCode });
    const response = await authorizedRequest(`/v2/bills?${query.toString()}`, { method: "GET" });
    if (!response.ok) {
      const body = await responseBody(response);
      throw new FactusApiError(errorMessage(body, `Factus consulta de referencia respondió ${response.status}`), response.status);
    }

    const body = await responseBody(response);
    return findInvoiceRecords(body).find((invoice) => invoice?.reference_code === referenceCode);
  }
}
