import { Worker, Job } from "bullmq";
import mongoose from "mongoose";
import { connection } from "../config/redis";
import { DIAN_QUEUE_NAME, DianJobData } from "../queues/dianQueue";
import { Sale } from "../models/Sale";
import type { InvoiceResult } from "../types/electronicInvoice";
import { dianService } from "../services/dianService";
import { reconcilePendingDianSales } from "../jobs/reconcilePendingDianSales";
import { applyInvoiceResult } from "../utils/applyInvoiceResult";
import { isFinalDianAttempt } from "../utils/dianRetryPolicy";

export interface DianWorkerHandle {
  worker: Worker<DianJobData>;
  stop: () => Promise<void>;
}

async function processJob(job: Job<DianJobData>) {
  const sale = await Sale.findById(job.data.saleId);
  if (!sale) {
    console.warn(`[DianWorker] Venta ${job.data.saleId} no encontrada, se descarta el job`);
    return;
  }

  if (sale.dianStatus === "APPROVED") {
    return; // ya procesada (idempotencia)
  }

  const isFinalAttempt = isFinalDianAttempt(job.attemptsMade, job.opts.attempts);

  let result: InvoiceResult;
  try {
    result = await dianService.emit(sale);
  } catch (error) {
    if (isFinalAttempt) {
      sale.dianStatus = "REJECTED";
      sale.category = "REGULAR";
      if (sale.electronicInvoice) {
        sale.electronicInvoice.lastError = error instanceof Error ? error.message : String(error);
      }
      await sale.save();
    }
    throw error;
  }

  applyInvoiceResult(sale, result);
  if (result.status === "REJECTED" && isFinalAttempt) {
    // La venta nominal sigue SPECIAL mientras BullMQ aún pueda reintentar;
    // si el rechazo es terminal, ya no ocupa el grupo de emisión.
    sale.category = "REGULAR";
  }
  await sale.save();

  if (result.status === "APPROVED") {
    console.log(`[DianWorker] Venta ${sale._id} aprobada. CUFE: ${result.cufe}`);
    return;
  }

  if (result.status === "PENDING" || result.status === "SENT") {
    // Factus puede aceptar la factura antes de que DIAN la valide. El job
    // termina sin repetir inmediatamente el POST; la reconciliación la
    // retomará con el proveedor ya bloqueado en Sale.electronicInvoice.
    return;
  }

  // REJECTED sigue disparando los reintentos/backoff ya configurados en BullMQ.
  throw new Error(result.error || "Rechazo desconocido del proveedor DIAN");
}

/**
 * Inicializa el worker DIAN dentro del proceso del backend (fase de unificación).
 * El antiguo proceso independiente (Render Background Worker) y su servidor HTTP
 * propio fueron retirados: el Express principal ya sirve `GET /health`, así que
 * basta un único Web Service en Render.
 */
export function startDianWorker(): DianWorkerHandle {
  const worker = new Worker<DianJobData>(DIAN_QUEUE_NAME, processJob, {
    connection,
    // Envío intercalado/balanceado: limita cuántos jobs se procesan por segundo (REQ-05)
    limiter: { max: 5, duration: 1000 },
    concurrency: 3,
    // Estos valores recortan el consumo ocioso de Upstash en una instancia que
    // combina API + worker; no retrasan la recogida real de un job nuevo
    // (ver punto 4 de backend/CLAUDE.md y la nota previa sobre el split de
    // disparadores: hoy esta cola solo la usa el Disparador 1).
    drainDelay: 60,
    stalledInterval: 300000,
  });

  worker.on("completed", (job) => {
    console.log(`[DianWorker] Job ${job.id} completado`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[DianWorker] Job ${job?.id} falló (intento ${job?.attemptsMade}): ${err.message}`);
  });

  console.log("[DianWorker] Worker de emisión DIAN escuchando en el mismo proceso del API");

  // Job de reconciliación: reencola ventas 'PENDING'/'SENT' que se quedaron
  // sin job vivo en la cola. Vive en el mismo proceso que el worker para no
  // requerir infraestructura adicional (no es un cron del sistema operativo).
  const intervalMinutes = Number(process.env.RECONCILE_INTERVAL_MINUTES) || 5;
  let reconcileTimer: NodeJS.Timeout | undefined;

  const runReconcileOnce = () =>
    reconcilePendingDianSales().catch((err) =>
      console.error("[Reconciliation] Error:", err)
    );

  runReconcileOnce();
  reconcileTimer = setInterval(runReconcileOnce, intervalMinutes * 60 * 1000);

  console.log(
    `[Reconciliation] Programada cada ${intervalMinutes} minuto(s) (ventas con más de ${
      process.env.RECONCILE_STALE_MINUTES || 2
    } minuto(s) de antigüedad).`
  );

  return {
    worker,
    async stop() {
      if (reconcileTimer) clearInterval(reconcileTimer);
      await worker.close();
    },
  };
}

/**
 * Crea el worker sin iniciar el trabajo periódico, para los tests automatizados
 * (no crea jobs reales y evita contaminar las pruebas con un setInterval).
 */
export function startDianWorkerForTests(): DianWorkerHandle {
  const worker = new Worker<DianJobData>(DIAN_QUEUE_NAME, processJob, {
    connection,
    drainDelay: 60,
    stalledInterval: 300000,
  });
  return {
    worker,
    async stop() {
      await worker.close();
    },
  };
}

export async function shutdownDianWorker(handle?: DianWorkerHandle): Promise<void> {
  if (handle) {
    await handle.stop();
  }
}

// Compatibilidad temporal: si se invoca este archivo con `ts-node`/`node`, se
// conserva el comportamiento anterior para depuración local (mismo proceso que
// el API). En Render ya no se usa porque el worker vive dentro de `npm run dev`
// y del binario compilado del API.
if (require.main === module) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { connectDB } = require("../config/db");
  (async () => {
    await connectDB();
+    startDianWorker();
  })().catch((err) => {
    console.error("[DianWorker] Error fatal al iniciar:", err);
    process.exit(1);
  });

  process.on("SIGINT", async () => {
    await mongoose.disconnect();
    process.exit(0);
  });
}
