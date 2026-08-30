import { Request, Response } from "express";
import { CashClosure, ICashClosure, IStockVerification } from "../models/CashClosure";
import { Sale } from "../models/Sale";
import { Expense } from "../models/Expense";
import { User } from "../models/User";
import { Product } from "../models/Product";
import { ProductStock } from "../models/ProductStock";
import { logCashClosureToSheets } from "../utils/sheetsSync";
import { resolveBranchFilter } from "./adminController";
import { startOfLocalDay, endOfLocalDay } from "../utils/dateRange";

/**
 * Calcula el desglose de ventas/gastos de un turno (por método de pago,
 * gastos de caja menor, y el efectivo/Nequi que el sistema espera) —
 * compartido entre el resumen que ve el cajero ANTES de declarar
 * (`getShiftSummary`, ver nota sobre arqueo no-ciego más abajo) y el
 * cálculo real que hace `closeShift` al cerrar, para no duplicar la
 * lógica en dos lugares que podrían desincronizarse.
 */
async function computeShiftFinancials(shift: ICashClosure) {
  const sales = await Sale.find({
    branchId: shift.branchId,
    cashierId: shift.cashierId,
    createdAt: { $gte: shift.openedAt },
  });

  const cashSales = sales
    .filter((s) => s.paymentMethod === "CASH")
    .reduce((acc, s) => acc + s.total, 0);
  const cardTotal = sales
    .filter((s) => s.paymentMethod === "CARD")
    .reduce((acc, s) => acc + s.total, 0);
  const nequiTotal = sales
    .filter((s) => s.paymentMethod === "NEQUI")
    .reduce((acc, s) => acc + s.total, 0);
  const appsTotal = sales
    .filter((s) => s.paymentMethod === "DELIVERY_APP")
    .reduce((acc, s) => acc + s.total, 0);

  const pettyCashExpenses = (
    await Expense.find({
      branchId: shift.branchId,
      registeredBy: shift.cashierId,
      category: "PETTY_CASH",
      createdAt: { $gte: shift.openedAt },
    })
  ).reduce((acc, e) => acc + e.amount, 0);

  const systemCalculatedCash = shift.initialCash + cashSales - pettyCashExpenses;
  // El saldo de Nequi no se gasta en efectivo (no hay "caja menor" en
  // Nequi), así que a diferencia del efectivo solo suma la base inicial
  // más lo vendido por ese medio — nada se resta.
  const systemCalculatedNequi = shift.initialNequi + nequiTotal;

  return {
    cashSales,
    cardTotal,
    nequiTotal,
    appsTotal,
    pettyCashExpenses,
    systemCalculatedCash,
    systemCalculatedNequi,
  };
}

/**
 * Arma el snapshot de stock (SKU, nombre, precio, cantidad, valor total)
 * para la sede de la sesión — siempre calculado por el backend a partir de
 * `ProductStock`/`Product` en el momento exacto de abrir/cerrar turno,
 * nunca confiando en algo que mande el cliente, así queda como un registro
 * histórico fiel de "qué había" en ese instante. Solo incluye productos
 * con stock > 0 — no tiene sentido pedirle al cajero que verifique algo
 * que ya está en 0 (mismo criterio que `getCatalog` en posController.ts
 * para el grid de venta).
 */
async function buildStockSnapshot(branchId: string) {
  const stocks = await ProductStock.find({ branchId, quantity: { $gt: 0 } }).lean();
  const productIds = stocks.map((s) => s.productId);
  const products = await Product.find({ _id: { $in: productIds }, active: true })
    .select("sku name price")
    .lean();
  const quantityByProduct = new Map(stocks.map((s) => [String(s.productId), s.quantity]));

  return products
    .map((p) => {
      const quantity = quantityByProduct.get(String(p._id)) || 0;
      return { sku: p.sku, name: p.name, price: p.price, quantity, totalValue: p.price * quantity };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** GET /api/pos/stock-snapshot -> tabla de stock actual de la sede, para la verificación de apertura/cierre de turno */
export async function getStockSnapshot(req: Request, res: Response) {
  const posSession = req.posSession!;
  const snapshot = await buildStockSnapshot(posSession.branchId);
  return res.json(snapshot);
}

function parseStockVerification(req: Request): IStockVerification {
  const { stockConfirmed, stockAnnotation } = req.body as {
    stockConfirmed?: boolean;
    stockAnnotation?: string;
  };
  return {
    confirmed: Boolean(stockConfirmed),
    annotation: stockAnnotation || undefined,
    snapshot: [],
    verifiedAt: new Date(),
  };
}

/**
 * GET /api/pos/shifts/current -> id del turno OPEN del cajero en su sede,
 * o `null` si no tiene ninguno abierto. Fuente de verdad server-side para
 * que `Caja.tsx` sepa si debe bloquear la pantalla con el botón "Iniciar
 * turno" — a propósito NO se resuelve solo con `localStorage`
 * (`pos_open_shift_id` quedó abandonado por esto mismo, ver punto 30: un
 * id guardado en el cliente puede apuntar a un turno que ya no existe).
 */
export async function getCurrentShift(req: Request, res: Response) {
  const posSession = req.posSession!;
  const shift = await CashClosure.findOne({
    branchId: posSession.branchId,
    cashierId: posSession.cashierId,
    status: "OPEN",
  });
  return res.json({ shiftId: shift ? String(shift._id) : null });
}

/** POST /api/pos/shifts/open  { initialCash, initialNequi, stockConfirmed, stockAnnotation } */
export async function openShift(req: Request, res: Response) {
  const posSession = req.posSession!;
  const { initialCash, initialNequi } = req.body;

  const stockVerification = parseStockVerification(req);
  if (!stockVerification.confirmed && !stockVerification.annotation) {
    return res.status(400).json({
      error: "Si el stock no es correcto, agrega una anotación describiendo la diferencia",
    });
  }

  const openShiftExisting = await CashClosure.findOne({
    branchId: posSession.branchId,
    cashierId: posSession.cashierId,
    status: "OPEN",
  });

  if (openShiftExisting) {
    return res.status(409).json({ error: "Ya existe un turno abierto para este cajero" });
  }

  stockVerification.snapshot = await buildStockSnapshot(posSession.branchId);

  const shift = await CashClosure.create({
    branchId: posSession.branchId,
    cashierId: posSession.cashierId,
    openedAt: new Date(),
    initialCash: initialCash || 0,
    initialNequi: initialNequi || 0,
    status: "OPEN",
    openingStockVerification: stockVerification,
  });

  return res.status(201).json(shift);
}

/**
 * GET /api/pos/shifts/:id/summary
 * Resumen de ventas/gastos del turno abierto, para mostrarlo en el modal
 * de cierre ANTES de que el cajero declare el efectivo/Nequi contado — a
 * pedido explícito del negocio, esto ya NO es un arqueo ciego (antes
 * `closeShift` era la única fuente de este cálculo, y solo se revelaba
 * después de declarar). Se deja como un endpoint de solo lectura, aparte,
 * para poder consultarlo repetidas veces sin efectos secundarios mientras
 * el cajero todavía está llenando el formulario.
 */
export async function getShiftSummary(req: Request, res: Response) {
  const posSession = req.posSession!;
  const { id } = req.params;

  const shift = await CashClosure.findOne({
    _id: id,
    branchId: posSession.branchId,
    cashierId: posSession.cashierId,
  });

  if (!shift) {
    return res.status(404).json({ error: "Turno no encontrado" });
  }

  const financials = await computeShiftFinancials(shift);

  return res.json({
    initialCash: shift.initialCash,
    initialNequi: shift.initialNequi,
    ...financials,
  });
}

/**
 * POST /api/pos/shifts/:id/close
 * El cajero declara el efectivo/Nequi contado; el backend calcula
 * `systemCalculatedCash`/`systemCalculatedNequi` a partir de las ventas y
 * gastos del turno y guarda la diferencia. El resumen (`getShiftSummary`)
 * ya se le mostró antes de declarar (ver nota ahí sobre por qué esto dejó
 * de ser un arqueo ciego).
 */
export async function closeShift(req: Request, res: Response) {
  const posSession = req.posSession!;
  const { id } = req.params;
  const { declaredCash, declaredNequi, reportType } = req.body as {
    declaredCash: number;
    declaredNequi: number;
    reportType: "X" | "Z";
  };

  const stockVerification = parseStockVerification(req);
  if (!stockVerification.confirmed && !stockVerification.annotation) {
    return res.status(400).json({
      error: "Si el stock no es correcto, agrega una anotación describiendo la diferencia",
    });
  }

  const shift = await CashClosure.findOne({
    _id: id,
    branchId: posSession.branchId,
    cashierId: posSession.cashierId,
  });

  if (!shift) {
    return res.status(404).json({ error: "Turno no encontrado" });
  }

  const { cashSales, cardTotal, nequiTotal, appsTotal, pettyCashExpenses, systemCalculatedCash, systemCalculatedNequi } =
    await computeShiftFinancials(shift);
  const difference = (declaredCash || 0) - systemCalculatedCash;
  const nequiDifference = (declaredNequi || 0) - systemCalculatedNequi;

  stockVerification.snapshot = await buildStockSnapshot(posSession.branchId);

  shift.closedAt = new Date();
  shift.declaredCash = declaredCash;
  shift.systemCalculatedCash = systemCalculatedCash;
  shift.difference = difference;
  shift.declaredNequi = declaredNequi;
  shift.systemCalculatedNequi = systemCalculatedNequi;
  shift.nequiDifference = nequiDifference;
  shift.cardTotal = cardTotal;
  shift.nequiTotal = nequiTotal;
  shift.appsTotal = appsTotal;
  shift.pettyCashExpenses = pettyCashExpenses;
  shift.reportType = reportType || "Z";
  shift.status = reportType === "X" ? "OPEN" : "CLOSED";
  shift.closingStockVerification = stockVerification;

  await shift.save();

  // Solo el cierre final (reporte Z) se sincroniza a Sheets — un "X" es un
  // corte intermedio que deja el turno abierto (status sigue "OPEN"), no
  // el cierre de caja real del día.
  if (shift.reportType !== "X") {
    const totalSales = cashSales + cardTotal + nequiTotal + appsTotal;
    logCashClosureToSheets({
      branchId: shift.branchId,
      date: shift.closedAt || new Date(),
      totalSales,
      cash: cashSales,
      nequi: nequiTotal,
      card: cardTotal,
      deliveryApps: appsTotal,
      pettyCashExpenses,
      discrepancy: difference,
    }).catch((err) => {
      console.error(`[closeShift] No se pudo sincronizar el cierre de caja ${shift._id} a Sheets:`, err);
    });
  }

  // Si hay discrepancia relevante (efectivo o Nequi), se reporta de
  // inmediato (aquí se retorna en la respuesta; en producción esto
  // dispararía una notificación push/websocket al administrador).
  const hasDiscrepancy = Math.abs(difference) > 0 || Math.abs(nequiDifference) > 0;

  return res.json({ shift, hasDiscrepancy });
}

/* ------------------------- Finanzas > Caja (admin) ------------------------- */

/**
 * GET /api/admin/cash-closures/cashiers?branchId= -> lookup mínimo (id +
 * nombre) de cajeros activos de una sede, para el `<select>` de
 * `CashClosureModal.tsx`. NO es `listUsers` (que es ADMIN-only, ver punto
 * 21 de CLAUDE.md) — un GERENTE necesita poder elegir un cajero de su
 * propia sede al crear/editar un registro de caja, así que este endpoint
 * queda abierto a ambos roles, igual que `GET /branches`, sin exponer nada
 * más que id/nombre.
 */
export async function listCashiersForClosures(req: Request, res: Response) {
  const branchId = resolveBranchFilter(req);
  const filter: any = { role: "CASHIER", active: true };
  if (branchId) filter.branchId = branchId;

  const cashiers = await User.find(filter).select("name branchId").sort({ name: 1 }).lean();
  return res.json(cashiers);
}

/**
 * GET /api/admin/cash-closures -> vista consolidada de aperturas/cierres de
 * turno para el panel admin (Finanzas > Caja). Un GERENTE solo ve las de su
 * propia sede (resolveBranchFilter, igual que Ventas/Compras).
 */
export async function listCashClosuresAdmin(req: Request, res: Response) {
  const { from, to, cashierId } = req.query;
  const branchId = resolveBranchFilter(req);
  const filter: any = {};
  if (branchId) filter.branchId = branchId;
  if (cashierId) filter.cashierId = String(cashierId);
  // `startOfLocalDay`/`endOfLocalDay` (ver punto 33/24 de CLAUDE.md) — antes
  // esto usaba `new Date(string)` a secas, el mismo bug de zona horaria ya
  // corregido en `listSales`/`listPurchasesAdmin`/`listExpenses`, que nadie
  // había replicado acá todavía porque el filtro de fecha existía en el
  // backend desde antes pero `FinanzasCaja.tsx` nunca lo usaba.
  if (from || to) {
    filter.openedAt = {};
    if (from) filter.openedAt.$gte = startOfLocalDay(String(from));
    if (to) filter.openedAt.$lte = endOfLocalDay(String(to));
  }

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));

  const [closures, total] = await Promise.all([
    CashClosure.find(filter)
      .sort({ openedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate("branchId", "name")
      .populate("cashierId", "name"),
    CashClosure.countDocuments(filter),
  ]);

  return res.json({
    data: closures,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

/**
 * POST /api/admin/cash-closures -> el admin/gerente registra manualmente un
 * turno (ej. uno que no se abrió/cerró desde el POS del cajero, o para
 * corregir un dato). A diferencia de openShift/closeShift (arqueo ciego
 * automático a partir de Sale/Expense reales), acá se capturan todos los
 * campos directamente — no hay sesión de cajero real detrás.
 */
export async function createCashClosureAdmin(req: Request, res: Response) {
  const {
    branchId,
    cashierId,
    openedAt,
    closedAt,
    initialCash,
    initialNequi,
    declaredCash,
    systemCalculatedCash,
    cardTotal,
    nequiTotal,
    appsTotal,
    pettyCashExpenses,
    reportType,
    status,
  } = req.body;

  if (!branchId || !cashierId || !openedAt) {
    return res.status(400).json({ error: "Sede, cajero y fecha de apertura son requeridos" });
  }

  // Un GERENTE solo puede registrar cierres de su propia sede — mismo
  // principio que createSaleAdmin/createPurchaseAdmin.
  const effectiveBranchId = req.admin?.role === "MANAGER" ? req.admin.branchId : branchId;

  const declared = declaredCash !== undefined && declaredCash !== "" ? Number(declaredCash) : undefined;
  const calculated =
    systemCalculatedCash !== undefined && systemCalculatedCash !== "" ? Number(systemCalculatedCash) : undefined;

  const closure = await CashClosure.create({
    branchId: effectiveBranchId,
    cashierId,
    openedAt: new Date(openedAt),
    closedAt: closedAt ? new Date(closedAt) : undefined,
    initialCash: Number(initialCash) || 0,
    initialNequi: Number(initialNequi) || 0,
    declaredCash: declared,
    systemCalculatedCash: calculated,
    difference: declared !== undefined && calculated !== undefined ? declared - calculated : undefined,
    cardTotal: Number(cardTotal) || 0,
    nequiTotal: Number(nequiTotal) || 0,
    appsTotal: Number(appsTotal) || 0,
    pettyCashExpenses: Number(pettyCashExpenses) || 0,
    reportType: reportType || undefined,
    status: status || (closedAt ? "CLOSED" : "OPEN"),
  });

  await closure.populate("branchId", "name");
  await closure.populate("cashierId", "name");

  return res.status(201).json(closure);
}

/** PUT /api/admin/cash-closures/:id -> edita cualquier campo de un registro existente. */
export async function updateCashClosureAdmin(req: Request, res: Response) {
  const closure = await CashClosure.findById(req.params.id);
  if (!closure) return res.status(404).json({ error: "Registro no encontrado" });

  if (req.admin?.role === "MANAGER" && String(closure.branchId) !== req.admin.branchId) {
    return res.status(403).json({ error: "No tienes acceso a este registro" });
  }

  const {
    cashierId,
    openedAt,
    closedAt,
    initialCash,
    initialNequi,
    declaredCash,
    systemCalculatedCash,
    cardTotal,
    nequiTotal,
    appsTotal,
    pettyCashExpenses,
    reportType,
    status,
  } = req.body;

  // La sede NO es editable acá a propósito — un MANAGER no debería poder
  // "mover" un registro fuera de su propia sede, y para un ADMIN cambiar
  // la sede de un cierre ya registrado es más una corrección de datos que
  // debería hacerse borrando y recreando, no editando in-place.
  if (cashierId !== undefined) closure.cashierId = cashierId;
  if (openedAt !== undefined) closure.openedAt = new Date(openedAt);
  if (closedAt !== undefined) closure.closedAt = closedAt ? new Date(closedAt) : undefined;
  if (initialCash !== undefined) closure.initialCash = Number(initialCash) || 0;
  if (initialNequi !== undefined) closure.initialNequi = Number(initialNequi) || 0;
  if (declaredCash !== undefined) closure.declaredCash = declaredCash === "" ? undefined : Number(declaredCash);
  if (systemCalculatedCash !== undefined)
    closure.systemCalculatedCash = systemCalculatedCash === "" ? undefined : Number(systemCalculatedCash);
  if (cardTotal !== undefined) closure.cardTotal = Number(cardTotal) || 0;
  if (nequiTotal !== undefined) closure.nequiTotal = Number(nequiTotal) || 0;
  if (appsTotal !== undefined) closure.appsTotal = Number(appsTotal) || 0;
  if (pettyCashExpenses !== undefined) closure.pettyCashExpenses = Number(pettyCashExpenses) || 0;
  if (reportType !== undefined) closure.reportType = reportType || undefined;
  if (status !== undefined) closure.status = status;

  closure.difference =
    closure.declaredCash !== undefined && closure.systemCalculatedCash !== undefined
      ? closure.declaredCash - closure.systemCalculatedCash
      : undefined;

  await closure.save();
  await closure.populate("branchId", "name");
  await closure.populate("cashierId", "name");

  return res.json(closure);
}

/** DELETE /api/admin/cash-closures/:id -> borra el registro (no afecta stock ni ventas). */
export async function deleteCashClosureAdmin(req: Request, res: Response) {
  const closure = await CashClosure.findById(req.params.id);
  if (!closure) return res.status(404).json({ error: "Registro no encontrado" });

  if (req.admin?.role === "MANAGER" && String(closure.branchId) !== req.admin.branchId) {
    return res.status(403).json({ error: "No tienes acceso a este registro" });
  }

  await closure.deleteOne();
  return res.status(204).send();
}
