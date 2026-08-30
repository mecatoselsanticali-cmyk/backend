import { CashClosure } from "../models/CashClosure";
import { getStartOfTodayColombia } from "./dateRange";

/**
 * Límite inferior del turno más reciente de un cajero en su sede — el
 * `openedAt` del último `CashClosure` que abrió, sin importar si ya lo
 * cerró o sigue abierto. Reemplaza el filtro anterior por día calendario
 * (`startOfDay`): un turno puede empezar un día y terminar al siguiente
 * (turno nocturno), así que "hoy" cortaba mal esos casos — con esto,
 * Facturas/Compras del cajero muestran todo desde que abrió su turno
 * actual, sin importar si eso cruza medianoche o si cerró sesión y volvió
 * a entrar mientras el turno seguía abierto.
 *
 * A propósito NO se pone un límite superior en `closedAt` — si el cajero
 * sigue vendiendo/comprando después de cerrar (Z) pero antes de abrir el
 * siguiente turno, esas ventas seguirían apareciendo bajo el turno
 * anterior en vez de quedar en un "limbo" invisible hasta que abra uno
 * nuevo.
 *
 * Si el cajero nunca ha abierto un turno (nunca usó el arqueo), cae a
 * "desde el inicio del día calendario" como red de seguridad — el mismo
 * límite que se usaba antes de que existiera el concepto de turno.
 */
export async function getCashierShiftStart(branchId: string, cashierId: string): Promise<Date> {
  const lastShift = await CashClosure.findOne({ branchId, cashierId }).sort({ openedAt: -1 });
  if (lastShift) return lastShift.openedAt;

  return getStartOfTodayColombia();
}
