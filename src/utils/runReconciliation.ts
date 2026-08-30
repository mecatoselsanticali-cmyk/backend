import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db";
import { reconcilePendingDianSales } from "../jobs/reconcilePendingDianSales";
import { connection } from "../config/redis";

/**
 * Ejecuta una única corrida de reconciliación y termina.
 * Útil para forzarla manualmente después de un incidente (ej. Redis estuvo
 * caído un rato) sin tener que esperar al siguiente ciclo automático del
 * worker, o para correrla como un cron externo si prefieres esa vía en vez
 * del setInterval embebido en dianWorker.ts.
 *
 * Uso: npm run reconcile:dian
 */
async function main() {
  await connectDB();
  const result = await reconcilePendingDianSales();
  console.log("[Reconciliation] Resultado:", result);
  await mongoose.disconnect();
  await connection.quit();
  process.exit(0);
}

main().catch((err) => {
  console.error("[Reconciliation] Error fatal:", err);
  process.exit(1);
});
