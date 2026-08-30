import { SheetsAction } from "../queues/sheetsQueue";

export interface SheetsPushResult {
  ok: boolean;
  message?: string;
}

/**
 * Único punto de integración con el Google Apps Script Web App (ver
 * docs/GOOGLE_SHEETS_INTEGRATION.md) — mismo rol que dianService.ts para
 * DIAN (punto 10 de CLAUDE.md): si el webhook cambia de forma o necesita
 * autenticación adicional en el futuro, el cambio va acá, no en el worker
 * ni en los controladores que encolan los jobs.
 */
class GoogleSheetsService {
  async push(action: SheetsAction, payload: Record<string, unknown>): Promise<SheetsPushResult> {
    const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
    if (!url) {
      return { ok: false, message: "GOOGLE_SHEETS_WEBHOOK_URL no está configurada" };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, payload }),
      // Google Apps Script puede tardar varios segundos en frío — más
      // generoso que el timeout de 8s del frontend porque esto corre en
      // background, nunca bloqueando una respuesta HTTP al usuario.
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      return { ok: false, message: `El webhook respondió ${res.status}` };
    }

    const body = (await res.json().catch(() => null)) as { status?: string; message?: string } | null;
    if (body?.status === "ERROR") {
      return { ok: false, message: body.message || "Error desconocido del webhook" };
    }

    return { ok: true };
  }
}

export const googleSheetsService = new GoogleSheetsService();
