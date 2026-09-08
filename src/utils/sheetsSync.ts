import { Branch } from "../models/Branch";
import { User } from "../models/User";
import { Product } from "../models/Product";
import { ProductStock } from "../models/ProductStock";
import { ISale } from "../models/Sale";
import { IPurchase } from "../models/Purchase";
import { IExpense } from "../models/Expense";
import { IStockLoss } from "../models/StockLoss";
import { enqueueSheetsSync } from "../queues/sheetsQueue";

/**
 * Helpers para sincronizar en tiempo real hacia Google Sheets (ver
 * docs/GOOGLE_SHEETS_INTEGRATION.md). TODAS estas funciones son
 * fire-and-forget por diseño — se llaman como
 * `syncXToSheets(...).catch((err) => console.error(...))`, SIN await,
 * desde el controlador que hizo la mutación real. Igual que
 * `enqueueSaleForDianEmission` (punto 2 de CLAUDE.md), un problema acá
 * (Redis caído, sede borrada, etc.) nunca debe tumbar la respuesta al
 * cliente ni revertir la operación real (que ya se guardó en Mongo antes
 * de llamar a estas funciones).
 */

async function branchName(branchId: unknown): Promise<string> {
  const branch = await Branch.findById(branchId as string).select("name").lean();
  return branch?.name || "Sede desconocida";
}

async function userName(userId: unknown): Promise<string> {
  const user = await User.findById(userId as string).select("name").lean();
  return user?.name || "Usuario desconocido";
}

/**
 * Recalcula el stock de un producto en TODAS las sedes activas y
 * sincroniza su fila en la pestaña INVENTORY. Se llama tras cualquier
 * mutación de `ProductStock` (compra, top-up manual, venta admin,
 * cancelación) — nunca hace falta pasarle un delta, siempre recalcula el
 * estado completo para que la fila en Sheets quede consistente aunque se
 * pierda algún job intermedio.
 */
export async function syncInventoryToSheets(productId: unknown) {
  const [product, branches, stocks] = await Promise.all([
    Product.findById(productId as string).select("sku name category").lean(),
    Branch.find({ status: true }).select("name").lean(),
    ProductStock.find({ productId: productId as string }).lean(),
  ]);
  if (!product) return;

  const quantityByBranch = new Map(stocks.map((s) => [String(s.branchId), s.quantity]));
  const stockByBranch = branches.map((b) => ({
    branchName: b.name,
    quantity: quantityByBranch.get(String(b._id)) || 0,
  }));
  const totalStock = stockByBranch.reduce((sum, b) => sum + b.quantity, 0);

  await enqueueSheetsSync("UPDATE_INVENTORY", {
    sku: product.sku,
    productName: product.name,
    category: product.category,
    stockByBranch,
    totalStock,
  });
}

/**
 * Registra una venta (admin o cajero) como fila en OPERATIONAL_LOGS.
 * Incluye `paymentStatus` (COMPLETED / PENDING_PAYMENT — ver punto 34 de
 * CLAUDE.md) para que el mirror de Sheets pueda distinguir ventas DiDi/
 * Rappi todavía no liquidadas. Como esta tabla es append-only (ver
 * docs/GOOGLE_SHEETS_INTEGRATION.md), confirmar el pago después NO reescribe
 * esta fila — la hoja solo refleja el estado al momento de la venta.
 * `logPaymentConfirmationToSheets` (más abajo) es cómo Sheets SÍ se entera
 * de una confirmación posterior, como una fila nueva de ajuste en vez de
 * reescribir esta.
 */
export async function logSaleToSheets(sale: ISale) {
  const [branch, cashier] = await Promise.all([branchName(sale.branchId), userName(sale.cashierId)]);
  await enqueueSheetsSync("LOG_TRANSACTION", {
    branch,
    movementType: "SALE",
    category: sale.category,
    descriptionOrId: String(sale._id),
    amount: sale.total,
    paymentMethod: sale.paymentMethod,
    paymentStatus: sale.paymentStatus,
    cashierUser: cashier,
  });
}

/**
 * Registra la CONFIRMACIÓN de pago de una venta DELIVERY_APP (individual o
 * en bloque, ver punto 53 de admin-frontend/CLAUDE.md) como una fila NUEVA
 * en OPERATIONAL_LOGS — no reescribe la fila original de `logSaleToSheets`
 * (esa tabla es append-only, ver la nota ahí arriba). `movementType:
 * "PAYMENT_CONFIRMATION"` es un valor nuevo que `Code.gs` acepta sin
 * cambios (`handleOperationalLog` no valida `movementType` contra una
 * lista fija, mismo caso ya documentado para `"STOCK_LOSS"`, ver punto 45
 * en admin-frontend/src/cajero/CLAUDE.md). `descriptionOrId` referencia la
 * venta original y el comprobante (si el admin lo escribió) para poder
 * cruzar ambas filas a mano en la hoja.
 */
export async function logPaymentConfirmationToSheets(sale: ISale) {
  const [branch, cashier] = await Promise.all([branchName(sale.branchId), userName(sale.cashierId)]);
  await enqueueSheetsSync("LOG_TRANSACTION", {
    branch,
    movementType: "PAYMENT_CONFIRMATION",
    category: sale.category,
    descriptionOrId: sale.settlementReference
      ? `Venta ${String(sale._id)} — comprobante ${sale.settlementReference}`
      : `Venta ${String(sale._id)}`,
    amount: sale.total,
    paymentMethod: sale.paymentMethod,
    paymentStatus: sale.paymentStatus,
    cashierUser: cashier,
  });
}

/** Registra una compra (admin o cajero) como fila en OPERATIONAL_LOGS. */
export async function logPurchaseToSheets(purchase: IPurchase) {
  const [branch, registeredBy, product] = await Promise.all([
    branchName(purchase.branchId),
    userName(purchase.registeredBy),
    purchase.productId ? Product.findById(purchase.productId).select("name").lean() : null,
  ]);
  await enqueueSheetsSync("LOG_TRANSACTION", {
    branch,
    movementType: "PURCHASE",
    category: "",
    descriptionOrId: product?.name
      ? `${purchase.concept} (${product.name} x${purchase.quantity})`
      : purchase.concept,
    amount: purchase.amount,
    paymentMethod: purchase.paymentMethod,
    cashierUser: registeredBy,
  });
}

/** Registra un gasto (admin o gasto menor de caja del cajero) como fila en OPERATIONAL_LOGS. */
export async function logExpenseToSheets(expense: IExpense) {
  const [branch, registeredBy] = await Promise.all([
    branchName(expense.branchId),
    userName(expense.registeredBy),
  ]);
  await enqueueSheetsSync("LOG_TRANSACTION", {
    branch,
    movementType: "EXPENSE",
    category: expense.category,
    descriptionOrId: expense.concept,
    amount: expense.amount,
    paymentMethod: "N/A",
    cashierUser: registeredBy,
  });
}

/**
 * Registra una merma de stock (producto dañado/vencido, consumo interno de
 * un empleado, etc. — sin venta ni movimiento de dinero real detrás) como
 * fila en OPERATIONAL_LOGS, `movementType: "STOCK_LOSS"`. `amount` es el
 * valor de venta estimado de lo perdido (cantidad x precio del producto),
 * no dinero que de verdad se movió — así el reporte refleja el impacto
 * económico de la merma, no solo la cantidad. `Code.gs` no valida
 * `movementType` contra una lista fija (ver `handleOperationalLog` en
 * docs/GOOGLE_SHEETS_INTEGRATION.md) — un valor nuevo aparece tal cual en
 * la columna `Movement_Type`, sin requerir ningún cambio del lado del
 * Apps Script.
 */
export async function logStockLossToSheets(stockLoss: IStockLoss) {
  const [branch, registeredBy, product] = await Promise.all([
    branchName(stockLoss.branchId),
    userName(stockLoss.registeredBy),
    Product.findById(stockLoss.productId).select("name price").lean(),
  ]);
  await enqueueSheetsSync("LOG_TRANSACTION", {
    branch,
    movementType: "STOCK_LOSS",
    category: stockLoss.reason,
    descriptionOrId: product?.name
      ? `${stockLoss.quantity} x ${product.name}${stockLoss.note ? ` — ${stockLoss.note}` : ""}`
      : `Merma (${stockLoss.quantity} unidades)`,
    amount: (product?.price || 0) * stockLoss.quantity,
    paymentMethod: "N/A",
    cashierUser: registeredBy,
  });
}

/**
 * Registra un cierre de caja (reporte Z) en CASH_CLOSURES. Los totales por
 * método de pago se pasan explícitos porque `cashClosureController.ts` ya
 * los calcula localmente al hacer el arqueo — no hace falta recalcularlos
 * acá.
 */
export async function logCashClosureToSheets(params: {
  branchId: unknown;
  date: Date;
  totalSales: number;
  cash: number;
  nequi: number;
  card: number;
  deliveryApps: number;
  pettyCashExpenses: number;
  discrepancy: number;
}) {
  const branch = await branchName(params.branchId);
  await enqueueSheetsSync("LOG_CASH_CLOSURE", {
    date: params.date.toISOString(),
    branch,
    totalSales: params.totalSales,
    cash: params.cash,
    nequi: params.nequi,
    card: params.card,
    deliveryApps: params.deliveryApps,
    pettyCashExpenses: params.pettyCashExpenses,
    discrepancy: params.discrepancy,
  });
}
