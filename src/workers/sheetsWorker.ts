import "dotenv/config";
import { Worker, Job } from "bullmq";
import { connection } from "../config/redis";
import { SHEETS_QUEUE_NAME, SheetsJobData } from "../queues/sheetsQueue";
import { googleSheetsService } from "../services/googleSheetsService";

/**
 * Worker de sincronización con Google Sheets — proceso separado del API,
 * igual que el worker DIAN (ver punto 5 de CLAUDE.md). A diferencia de
 * ese, no necesita conexión a Mongo: los jobs llegan con el payload ya
 * resuelto (ver sheetsQueue.ts / utils/sheetsSync.ts), así que este
 * proceso solo habla con Redis y con el webhook de Apps Script.
 */
async function processJob(job: Job<SheetsJobData>) {
  const result = await googleSheetsService.push(job.data.action, job.data.payload);
  if (!result.ok) {
    // Lanzar el error dispara el reintento con backoff exponencial de BullMQ.
    throw new Error(result.message || "Fallo desconocido al sincronizar con Sheets");
  }
}

const worker = new Worker<SheetsJobData>(SHEETS_QUEUE_NAME, processJob, {
  connection,
  concurrency: 3,
});

worker.on("completed", (job) => {
  console.log(`[SheetsWorker] Job ${job.id} (${job.data.action}) completado`);
});

worker.on("failed", (job, err) => {
  console.error(
    `[SheetsWorker] Job ${job?.id} (${job?.data.action}) falló (intento ${job?.attemptsMade}): ${err.message}`
  );
});

console.log("[SheetsWorker] Worker de sincronización con Google Sheets escuchando...");

process.on("SIGINT", async () => {
  await worker.close();
  process.exit(0);
});
