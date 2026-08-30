import "dotenv/config";
import { Worker, Job } from "bullmq";
import mongoose from "mongoose";
import { connection } from "../config/redis";
import { connectDB } from "../config/db";
import { DIAN_QUEUE_NAME, DianJobData } from "../queues/dianQueue";
import { Sale } from "../models/Sale";
import { dianService } from "../services/dianService";
import { reconcilePendingDianSales } from "../jobs/reconcilePendingDianSales";

async function processJob(job: Job<DianJobData>) {
  const sale = await Sale.findById(job.data.saleId);
  if (!sale) {
    console.warn(`[DianWorker] Venta ${job.data.saleId} no encontrada, se descarta el job`);
    return;
  }

  if (sale.dianStatus === "APPROVED") {
    return; // ya procesada (idempotencia)
  }

  const result = await dianService.emit(sale);

  if (result.status === "APPROVED") {
    sale.dianStatus = "APPROVED";
    sale.cufe = result.cufe;
    sale.qrCodeUrl = result.qrCodeUrl;
    await sale.save();
    console.log(`[DianWorker] Venta ${sale._id} aprobada. CUFE: ${result.cufe}`);
  } else {
    sale.dianStatus = "REJECTED";
    await sale.save();
    // Lanzar error para que BullMQ dispare el reintento con backoff exponencial
    throw new Error(result.errorMessage || "Rechazo desconocido del proveedor DIAN");
  }
}

async function main() {
  await connectDB();

  const worker = new Worker<DianJobData>(DIAN_QUEUE_NAME, processJob, {
    connection,
    // Envío intercalado/balanceado: limita cuántos jobs se procesan por segundo (REQ-05)
    limiter: { max: 5, duration: 1000 },
    concurrency: 3,
  });

  worker.on("completed", (job) => {
    console.log(`[DianWorker] Job ${job.id} completado`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[DianWorker] Job ${job?.id} falló (intento ${job?.attemptsMade}): ${err.message}`);
  });

  console.log("[DianWorker] Worker de emisión DIAN escuchando...");

  // Job de reconciliación: reencola ventas 'PENDING' que se quedaron sin job
  // vivo en la cola (ej. Redis caído justo al cobrar). Corre al arrancar y
  // luego periódicamente. Vive en el mismo proceso que el worker para no
  // requerir infraestructura adicional (no es un cron del sistema operativo).
  const intervalMinutes = Number(process.env.RECONCILE_INTERVAL_MINUTES) || 5;

  reconcilePendingDianSales().catch((err) =>
    console.error("[Reconciliation] Error en la corrida inicial:", err)
  );

  setInterval(() => {
    reconcilePendingDianSales().catch((err) =>
      console.error("[Reconciliation] Error en la corrida periódica:", err)
    );
  }, intervalMinutes * 60 * 1000);

  console.log(
    `[Reconciliation] Programada cada ${intervalMinutes} minuto(s) (ventas con más de ${
      process.env.RECONCILE_STALE_MINUTES || 2
    } minuto(s) de antigüedad).`
  );
}

main().catch((err) => {
  console.error("[DianWorker] Error fatal al iniciar el worker:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await mongoose.disconnect();
  process.exit(0);
});
