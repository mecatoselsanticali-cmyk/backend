import { Queue } from "bullmq";
import { connection } from "../config/redis";

export interface DianJobData {
  saleId: string;
}

export const DIAN_QUEUE_NAME = "dian-emission";

export const dianQueue = new Queue<DianJobData>(DIAN_QUEUE_NAME, { connection });

/** Job id determinístico por venta: permite deduplicar encolados (ver reconciliación). */
export function buildDianJobId(saleId: string) {
  return `dian-emission-${saleId}`;
}

/**
 * Encola una venta para emisión electrónica en segundo plano.
 * REQ-05: envío intercalado/balanceado + reintentos con backoff exponencial.
 *
 * Usa un jobId determinístico (uno por venta). Si ya existe un job para esa
 * venta en estado waiting/active/delayed, BullMQ no lo duplica — esto es lo
 * que permite que el job de reconciliación reintente encolar sin miedo a
 * generar doble procesamiento de la misma venta.
 */
export async function enqueueSaleForDianEmission(saleId: string) {
  // Interruptor temporal para pruebas: con DISABLE_DIAN_QUEUE=true no se
  // manda nada a Redis/Upstash para DIAN (ni siquiera el .add()) — se usó
  // mientras se probaba el proyecto antes de la integración con SIIGO,
  // para no seguir llenando el plan gratuito de Upstash con tráfico de
  // pruebas de DIAN específicamente (independiente de la cola de Sheets,
  // ver DISABLE_SHEETS_QUEUE en sheetsQueue.ts — esta SÍ debe seguir
  // funcionando). La venta queda con dianStatus=PENDING hasta que se
  // reactive (quitar la env var o ponerla en "false") y se corra
  // `npm run reconcile:dian`.
  if (process.env.DISABLE_DIAN_QUEUE === "true") {
    console.log(`[dianQueue] DISABLE_DIAN_QUEUE=true — se omite encolar la venta ${saleId}`);
    return;
  }
  await dianQueue.add(
    "emit-sale",
    { saleId },
    {
      jobId: buildDianJobId(saleId),
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

/**
 * Indica si ya existe un job "vivo" (esperando, activo o en delay/backoff)
 * para una venta específica. Un job que terminó en 'failed' tras agotar sus
 * reintentos, o que fue removido (removeOnComplete/removeOnFail), ya no
 * cuenta como vivo — en ese caso la reconciliación sí debe volver a encolar.
 */
export async function hasLiveDianJob(saleId: string): Promise<boolean> {
  const job = await dianQueue.getJob(buildDianJobId(saleId));
  if (!job) return false;

  const state = await job.getState();
  return state === "waiting" || state === "active" || state === "delayed" || state === "waiting-children";
}
