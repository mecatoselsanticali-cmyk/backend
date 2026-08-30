import { Sale } from "../models/Sale";
import { enqueueSaleForDianEmission, hasLiveDianJob } from "../queues/dianQueue";

/**
 * Reconciliación de emisión DIAN.
 *
 * Cubre el caso en el que una venta quedó en dianStatus='PENDING' sin que
 * exista (o sobreviva) un job en la cola que la procese — por ejemplo:
 *   - Redis estuvo caído justo cuando se intentó encolar tras el cobro
 *     (el controlador de ventas ya tolera este fallo y responde igual al
 *     cajero, ver posController.createSale).
 *   - El worker se cayó/reinició mientras el job estaba 'active'.
 *   - Se agotaron los 5 reintentos con backoff y el job terminó 'failed'.
 *
 * Solo se consideran ventas con más de STALE_MINUTES de antigüedad para no
 * pisar ventas que están en su ciclo normal de procesamiento (que toma
 * segundos, no minutos).
 */

const STALE_MINUTES = Number(process.env.RECONCILE_STALE_MINUTES) || 2;
const BATCH_LIMIT = 200; // evita cargar miles de ventas pendientes en una sola corrida

export interface ReconciliationResult {
  scanned: number;
  reenqueued: number;
  skippedWithLiveJob: number;
}

export async function reconcilePendingDianSales(): Promise<ReconciliationResult> {
  const staleThreshold = new Date(Date.now() - STALE_MINUTES * 60 * 1000);

  const staleSales = await Sale.find({
    dianStatus: "PENDING",
    createdAt: { $lt: staleThreshold },
  })
    .select("_id createdAt")
    .limit(BATCH_LIMIT)
    .lean();

  let reenqueued = 0;
  let skippedWithLiveJob = 0;

  for (const sale of staleSales) {
    const saleId = String(sale._id);

    const alreadyLive = await hasLiveDianJob(saleId);
    if (alreadyLive) {
      skippedWithLiveJob++;
      continue;
    }

    await enqueueSaleForDianEmission(saleId);
    reenqueued++;
  }

  const result: ReconciliationResult = {
    scanned: staleSales.length,
    reenqueued,
    skippedWithLiveJob,
  };

  if (result.scanned > 0) {
    console.log(
      `[Reconciliation] Analizadas ${result.scanned} ventas PENDING (>${STALE_MINUTES}min). ` +
        `Reencoladas: ${result.reenqueued}. Con job vivo (omitidas): ${result.skippedWithLiveJob}.`
    );
  }

  return result;
}
