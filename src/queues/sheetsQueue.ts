import { Queue } from "bullmq";
import { connection } from "../config/redis";

export type SheetsAction = "UPDATE_INVENTORY" | "LOG_TRANSACTION" | "LOG_CASH_CLOSURE";

export interface SheetsJobData {
  action: SheetsAction;
  payload: Record<string, unknown>;
}

export const SHEETS_QUEUE_NAME = "sheets-sync";

export const sheetsQueue = new Queue<SheetsJobData>(SHEETS_QUEUE_NAME, { connection });

/**
 * Encola una sincronización hacia el Google Apps Script Web App (ver
 * docs/GOOGLE_SHEETS_INTEGRATION.md). A diferencia de la cola DIAN, el job
 * lleva el payload ya resuelto (nombres de sede/usuario, no ids) — el
 * worker no necesita conexión a Mongo, solo hace el POST al webhook.
 * Igual que DIAN (ver dianQueue.ts): reintentos con backoff exponencial
 * ante caídas puntuales del webhook.
 */
export async function enqueueSheetsSync(action: SheetsAction, payload: Record<string, unknown>) {
  // Interruptor independiente del de DIAN (ver DISABLE_DIAN_QUEUE en
  // dianQueue.ts) — por defecto (sin la env var, o en "false") esta cola
  // sigue funcionando normal aunque DIAN esté pausada; el negocio quiere
  // seguir viendo los datos reflejados en Sheets durante las pruebas.
  if (process.env.DISABLE_SHEETS_QUEUE === "true") {
    console.log(`[sheetsQueue] DISABLE_SHEETS_QUEUE=true — se omite encolar ${action}`);
    return;
  }
  await sheetsQueue.add(
    action,
    { action, payload },
    {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 3000, // 3s, 6s, 12s, 24s, 48s...
      },
      removeOnComplete: 500,
      removeOnFail: 1000,
    }
  );
}
