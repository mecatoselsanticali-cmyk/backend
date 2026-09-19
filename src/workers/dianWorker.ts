import "dotenv/config";
import express from "express";
import { Worker, Job } from "bullmq";
import mongoose from "mongoose";
import { connection } from "../config/redis";
import { connectDB } from "../config/db";
import { DIAN_QUEUE_NAME, DianJobData } from "../queues/dianQueue";
import { Sale } from "../models/Sale";
import { dianService } from "../services/dianService";
import { reconcilePendingDianSales } from "../jobs/reconcilePendingDianSales";

// Servidor HTTP mínimo, solo para que Render acepte este proceso como Web
// Service en el plan gratis (que exige un puerto abierto; un Background
// Worker real requiere plan pago) — ver punto 67 de backend/CLAUDE.md para
// el detalle completo y los riesgos aceptados de este approach. No agrega
// `cors`: este endpoint solo lo golpea un monitor externo (UptimeRobot), no
// un navegador, mismo criterio que `GET /health` del API (punto 58).
//
// `DIAN_WORKER_PORT` tiene prioridad sobre `PORT` a propósito — en local,
// `dianWorker.ts` y `server.ts` cargan el mismo `backend/.env`
// (`import "dotenv/config"`), que ya trae `PORT=4000` para el API; si este
// servidor leyera `PORT` directo, correr `npm run dev` y `npm run
// worker:dian` a la vez revienta con `EADDRINUSE :4000` apenas arranca el
// segundo. En Render, el servicio del worker no necesita que definas
// `DIAN_WORKER_PORT` en el dashboard — con esa variable ausente cae solo a
// `PORT`, que Render inyecta automáticamente por su cuenta.
function startHealthServer() {
  const app = express();
  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "mecatos-dian-worker", uptime: process.uptime() });
  });
  const port = Number(process.env.DIAN_WORKER_PORT) || Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    console.log(`[DianWorker] Health check escuchando en :${port}`);
  });
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

  const result = await dianService.emit(sale);

  if (result.status === "APPROVED") {
    sale.dianStatus = "APPROVED";
    sale.cufe = result.cufe;
    sale.qrCodeUrl = result.qrCodeUrl;
    sale.dianInvoiceNumber = result.invoiceNumber;
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
  startHealthServer();
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
