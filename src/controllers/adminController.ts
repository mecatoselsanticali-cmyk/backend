import { Request, Response } from "express";
import { Branch } from "../models/Branch";
import { Product } from "../models/Product";
import { ProductStock } from "../models/ProductStock";
import { Sale, resolvePaymentStatus } from "../models/Sale";
import { User } from "../models/User";
import { AccountPayable, AccountReceivable } from "../models/Accounts";
import { Expense, IExpense } from "../models/Expense";
import { Purchase } from "../models/Purchase";
import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import { dianService } from "../services/dianService";
import { enqueueSaleForDianEmission } from "../queues/dianQueue";
import {
  syncInventoryToSheets,
  logSaleToSheets,
  logExpenseToSheets,
  logPaymentConfirmationToSheets,
} from "../utils/sheetsSync";
import {
  startOfLocalDay,
  endOfLocalDay,
  getStartOfTodayColombia,
  COLOMBIA_TIME_ZONE,
} from "../utils/dateRange";
import { sendWelcomeEmail } from "../utils/mailerResend";
import { generateResetToken } from "../utils/passwordResetToken";

/**
 * Un GERENTE (MANAGER) siempre queda restringido a su propia sede (la del
 * JWT con el que inició sesión) sin importar qué `branchId` mande en el
 * query string — así el filtrado por sede no depende de que el frontend se
 * comporte bien. Un ADMIN sigue pudiendo filtrar opcionalmente por sede (o
 * ver todas si no manda `branchId`).
 */
export function resolveBranchFilter(req: Request): string | undefined {
  if (req.admin?.role === "MANAGER") return req.admin.branchId;
  const { branchId } = req.query;
  return branchId ? String(branchId) : undefined;
}

/* --------------------------- Sedes (Branches) --------------------------- */

export async function listBranches(req: Request, res: Response) {
  const { includeInactive, search } = req.query;
  const filter: any = {};
  if (includeInactive !== "true") filter.status = true;

  // Búsqueda por nombre, dirección o teléfono — mismo patrón de regex
  // escapado + case-insensitive que `listSales` (ver más abajo en este
  // archivo), sin `$text` porque Branch no tiene un índice de texto y el
  // catálogo de sedes es demasiado pequeño para necesitarlo.
  if (search) {
    const term = String(search).trim();
    if (term) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { address: { $regex: escaped, $options: "i" } },
        { phone: { $regex: escaped, $options: "i" } },
      ];
    }
  }

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));

  const [branches, total] = await Promise.all([
    Branch.find(filter)
      .sort({ name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
    Branch.countDocuments(filter),
  ]);

  return res.json({
    data: branches,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

export async function createBranch(req: Request, res: Response) {
  const branch = await Branch.create(req.body);
  return res.status(201).json(branch);
}

export async function updateBranch(req: Request, res: Response) {
  const branch = await Branch.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!branch) return res.status(404).json({ error: "Sede no encontrada" });
  return res.json(branch);
}

/* --------------------------- Productos --------------------------- */

export async function listProducts(req: Request, res: Response) {
  const { category, search, includeInactive, branchId } = req.query;
  const filter: any = {};
  if (category) filter.category = category;
  if (search) filter.$text = { $search: String(search) };
  if (includeInactive !== "true") filter.active = true;

  // Si viene `branchId` (selector de sede en Inventario, o el modal de
  // "Agregar venta" eligiendo sede), el listado queda restringido a
  // productos con existencias > 0 en ESA sede — no tiene sentido mostrar
  // (ni poder vender) algo que ahí no hay. Sin `branchId` (ej. "Todas las
  // sedes"), se listan todos los productos, tengan o no stock en algún
  // lado. El filtro se arma ANTES de paginar para que `total`/`totalPages`
  // reflejen el conjunto ya filtrado, no el catálogo completo.
  let branchStockByProduct: Map<string, number> | null = null;
  if (branchId) {
    const branchStocks = await ProductStock.find({
      branchId: String(branchId),
      quantity: { $gt: 0 },
    }).lean();
    branchStockByProduct = new Map(branchStocks.map((s) => [String(s.productId), s.quantity]));
    filter._id = { $in: [...branchStockByProduct.keys()].map((id) => new Types.ObjectId(id)) };
  }

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));

  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort({ category: 1, name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    Product.countDocuments(filter),
  ]);

  const productIds = products.map((p) => p._id);
  const stockTotals = await ProductStock.aggregate([
    { $match: { productId: { $in: productIds } } },
    { $group: { _id: "$productId", total: { $sum: "$quantity" } } },
  ]);
  const totalByProduct = new Map(stockTotals.map((s) => [String(s._id), s.total]));

  const withStock = products.map((p) => ({
    ...p,
    totalStock: totalByProduct.get(String(p._id)) || 0,
    ...(branchStockByProduct ? { branchStock: branchStockByProduct.get(String(p._id)) || 0 } : {}),
  }));
  return res.json({
    data: withStock,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

// Arma el desglose de stock por sede de un producto, incluyendo sedes en
// 0 (sin documento de ProductStock todavía) para que el admin pueda asignarles
// cantidad desde cero.
async function buildProductStockSummary(productId: Types.ObjectId) {
  const [branches, stocks] = await Promise.all([
    Branch.find({ status: true }).sort({ name: 1 }).lean(),
    ProductStock.find({ productId }).lean(),
  ]);
  const quantityByBranch = new Map(stocks.map((s) => [String(s.branchId), s.quantity]));
  const branchStocks = branches.map((b) => ({
    branchId: String(b._id),
    branchName: b.name,
    quantity: quantityByBranch.get(String(b._id)) || 0,
  }));
  const total = branchStocks.reduce((sum, b) => sum + b.quantity, 0);
  return { branchStocks, total };
}

export async function getProductStock(req: Request, res: Response) {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: "Producto no encontrado" });
  return res.json(await buildProductStockSummary(product._id as Types.ObjectId));
}

export async function addProductStock(req: Request, res: Response) {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: "Producto no encontrado" });

  const allocations: { branchId?: string; quantity?: number }[] = req.body.allocations || [];
  const valid = allocations
    .filter((a) => a.branchId && Number.isFinite(Number(a.quantity)) && Number(a.quantity) > 0)
    .map((a) => ({ branchId: a.branchId as string, quantity: Math.floor(Number(a.quantity)) }));

  if (valid.length === 0) {
    return res.status(400).json({ error: "Debes asignar una cantidad mayor a cero a al menos una sede" });
  }

  const branchIds = valid.map((a) => a.branchId);
  const validBranchCount = await Branch.countDocuments({ _id: { $in: branchIds }, status: true });
  if (validBranchCount !== new Set(branchIds).size) {
    return res.status(400).json({ error: "Una o más sedes no son válidas" });
  }

  await Promise.all(
    valid.map((a) =>
      ProductStock.findOneAndUpdate(
        { productId: product._id, branchId: a.branchId },
        { $inc: { quantity: a.quantity } },
        { upsert: true }
      )
    )
  );

  syncInventoryToSheets(product._id as Types.ObjectId).catch((err) => {
    console.error(`[addProductStock] No se pudo sincronizar inventario de ${product._id} a Sheets:`, err);
  });

  return res.json(await buildProductStockSummary(product._id as Types.ObjectId));
}

const DIACRITICS_RE = new RegExp("[\\u0300-\\u036f]", "g");

function skuPrefixFromName(name: string): string {
  const letters = name
    .normalize("NFD")
    .replace(DIACRITICS_RE, "") // quita tildes antes de filtrar letras
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase();
  return (letters + "XXX").slice(0, 3);
}

async function nextSkuForName(name: string): Promise<string> {
  const prefix = skuPrefixFromName(name);
  const existing = await Product.find({ sku: { $regex: `^${prefix}-\\d{3}$` } })
    .select("sku")
    .lean();
  const maxSeq = existing.reduce((max, p) => {
    const seq = parseInt(p.sku.slice(prefix.length + 1), 10);
    return Number.isNaN(seq) ? max : Math.max(max, seq);
  }, -1);
  return `${prefix}-${String(maxSeq + 1).padStart(3, "0")}`;
}

export async function createProduct(req: Request, res: Response) {
  // El SKU se genera en el servidor (3 letras del nombre + secuencia), nunca
  // se toma del body — así el chequeo de duplicados contra Mongo es
  // consistente sin importar quién llame a este endpoint.
  let sku = await nextSkuForName(req.body.name);
  let attempts = 0;
  while (true) {
    try {
      const product = await Product.create({ ...req.body, sku });

      // Sincroniza de una vez aunque no tenga stock todavía en ninguna
      // sede (stockByBranch quedará en 0 por cada sede) — así el producto
      // ya aparece en la pestaña INVENTORY apenas se crea, sin esperar a
      // la primera compra o top-up de stock.
      syncInventoryToSheets(product._id as Types.ObjectId).catch((err) => {
        console.error(`[createProduct] No se pudo sincronizar inventario de ${product._id} a Sheets:`, err);
      });

      return res.status(201).json(product);
    } catch (err: any) {
      // Condición de carrera con el índice único: otra creación tomó ese
      // SKU entre el cálculo y el insert — reintenta con el siguiente.
      if (err?.code === 11000 && attempts < 5) {
        attempts += 1;
        const prefix = sku.slice(0, sku.lastIndexOf("-"));
        const seq = parseInt(sku.slice(prefix.length + 1), 10);
        sku = `${prefix}-${String(seq + 1).padStart(3, "0")}`;
        continue;
      }
      throw err;
    }
  }
}

export async function updateProduct(req: Request, res: Response) {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!product) return res.status(404).json({ error: "Producto no encontrado" });
  return res.json(product);
}

export async function deleteProduct(req: Request, res: Response) {
  await Product.findByIdAndUpdate(req.params.id, { active: false });
  return res.status(204).send();
}

/* --------------------------- Personal --------------------------- */

export async function listUsers(req: Request, res: Response) {
  const branchId = resolveBranchFilter(req);
  const { includeInactive, role, search } = req.query;
  const filter: any = {};
  if (branchId) filter.branchId = branchId;
  if (includeInactive !== "true") filter.active = true;
  if (role) filter.role = role;
  // Búsqueda por nombre o correo — mismo patrón de regex escapado +
  // case-insensitive que `listBranches` (nombre/dirección/teléfono), sin
  // `$text` por la misma razón: el catálogo de usuarios de una sede es
  // chico, no justifica un índice de texto.
  if (search) {
    const term = String(search).trim();
    if (term) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { email: { $regex: escaped, $options: "i" } },
      ];
    }
  }

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));

  const [users, total] = await Promise.all([
    User.find(filter)
      .select("-password -pin")
      .populate("branchId", "name")
      .sort({ name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
    User.countDocuments(filter),
  ]);

  // El admin nunca tiene sede, así que `branch`/`branchName` quedan null
  // para esas filas — la tabla de Personal ya maneja ese caso con "—".
  const withBranch = users.map((u: any) => ({
    ...u,
    branchId: u.branchId?._id ?? null,
    branchName: u.branchId?.name ?? null,
  }));

  return res.json({
    data: withBranch,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

/**
 * ¿Ya hay un cajero ACTIVO de esta misma sede usando este PIN? El PIN se
 * guarda hasheado (`pin: { select: false }` en el modelo, bcrypt vía
 * `comparePin`), así que no se puede buscar por igualdad directa como con
 * `email` — hay que traer a los candidatos y comparar uno por uno contra el
 * PIN en texto plano. Mismo filtro `{ branchId, role: "CASHIER", active:
 * true }` que usa `posLogin` (authController.ts) para resolver el PIN al
 * iniciar sesión: si dos cajeros activos de la misma sede compartieran PIN,
 * ese login sería ambiguo (toma el primero que matchee, sin garantía de
 * cuál), así que la validación tiene que ser fiel a ese mismo universo de
 * candidatos.
 */
async function isPinTakenInBranch(branchId: string, pin: string, excludeUserId?: string): Promise<boolean> {
  const filter: any = { branchId, role: "CASHIER", active: true };
  if (excludeUserId) filter._id = { $ne: excludeUserId };
  const candidates = await User.find(filter).select("+pin");
  for (const candidate of candidates) {
    if (await candidate.comparePin(pin)) return true;
  }
  return false;
}

export async function createUser(req: Request, res: Response) {
  const { name, role, email, password, pin } = req.body;
  let { branchId } = req.body;

  if (!name || !role) {
    return res.status(400).json({ error: "Nombre y rol son requeridos" });
  }

  // Un administrador no se asigna a ninguna sede; un gerente o cajero sí
  // (ver punto de arquitectura sobre roles en CLAUDE.md).
  if (role === "ADMIN") {
    branchId = undefined;
  } else if (!branchId) {
    return res.status(400).json({ error: "Selecciona la sede a la que tendrá acceso este usuario" });
  }

  if (role === "CASHIER" && pin && (await isPinTakenInBranch(branchId, pin))) {
    return res.status(409).json({ error: "Ese PIN ya está en uso por otro cajero activo de esta sede" });
  }

  // El índice único de email es sparse (permite muchos documentos SIN el
  // campo), pero "" sigue siendo un valor real para Mongo — dos cajeros
  // creados sin correo con email:"" chocan contra el índice igual que si
  // fuera un correo real duplicado. Normalizar a undefined deja el campo
  // completamente ausente, que es lo que el índice sparse sí ignora.
  const doc: any = { name, role, branchId, email: email || undefined };

  if (password) doc.password = await bcrypt.hash(password, 10);
  if (pin) doc.pin = await bcrypt.hash(pin, 10);

  const user = await User.create(doc);

  // Correo de bienvenida para ADMIN/MANAGER nuevos (ver punto 59 de
  // backend/CLAUDE.md) — nunca para CASHIER (no tiene `email`, usa PIN).
  // Fire-and-forget, mismo criterio que la sincronización con Google
  // Sheets (punto 21): un fallo de envío no debe tumbar la creación del
  // usuario, que ya se guardó con éxito en Mongo. A propósito NO manda la
  // contraseña en texto plano que el admin haya asignado — reutiliza el
  // mecanismo de "olvidé mi contraseña" (`generateResetToken()`) para que
  // el nuevo usuario configure su propia contraseña por un link de un solo
  // uso, en vez de exponerla por correo.
  if ((role === "ADMIN" || role === "MANAGER") && user.email) {
    const { rawToken, tokenHash, expires } = generateResetToken();
    user.resetPasswordTokenHash = tokenHash;
    user.resetPasswordExpires = expires;
    user
      .save()
      .then(() => {
        const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5174";
        const setupUrl = `${frontendUrl}/reset-password?token=${rawToken}`;
        return sendWelcomeEmail(user.email!, user.name, role, setupUrl);
      })
      .catch((err) => {
        console.error(`[createUser] No se pudo enviar el correo de bienvenida a ${user.email}:`, err);
      });
  }

  const safeUser = user.toObject();
  delete safeUser.password;
  delete safeUser.pin;
  // `resetPasswordTokenHash`/`resetPasswordExpires` tienen `select: false`
  // en el modelo, pero eso solo afecta a QUERIES nuevas — como el bloque de
  // arriba los asigna directo sobre este mismo documento en memoria (antes
  // de que termine su propio `.save()` async), `toObject()` sí los incluye.
  // Se borran acá igual que `password`/`pin`, para no filtrar el hash del
  // token (ni su expiración) en la respuesta de creación.
  delete safeUser.resetPasswordTokenHash;
  delete safeUser.resetPasswordExpires;

  return res.status(201).json(safeUser);
}

export async function updateUser(req: Request, res: Response) {
  const { name, role, email, password, pin } = req.body;

  let { branchId } = req.body;

  if (!name || !role) {
    return res.status(400).json({ error: "Nombre y rol son requeridos" });
  }

  // Un admin puede desactivar a cualquier otro usuario, pero nunca a sí
  // mismo — de lo contrario se quedaría sin sesión válida (adminMe
  // rechaza usuarios inactivos) sin ningún otro admin necesariamente
  // disponible para reactivarlo. El frontend ya oculta el botón de
  // "eliminar" en la propia fila (Personal.tsx), esto es la defensa del
  // lado del servidor por si esa restricción se saltara.
  const isSelf = String(req.admin!.userId) === String(req.params.id);
  if (isSelf && req.body.active === false) {
    return res.status(400).json({ error: "No puedes desactivar tu propia cuenta" });
  }

  if (role === "ADMIN") {
    branchId = undefined;
  } else if (!branchId) {
    return res.status(400).json({ error: "Selecciona la sede a la que tendrá acceso este usuario" });
  }

  if (role === "CASHIER" && pin && (await isPinTakenInBranch(branchId, pin, req.params.id))) {
    return res.status(409).json({ error: "Ese PIN ya está en uso por otro cajero activo de esta sede" });
  }

  const doc: any = { name, role, branchId };

  if (password) doc.password = await bcrypt.hash(password, 10);
  if (pin) doc.pin = await bcrypt.hash(pin, 10);

  // Mismo problema que en createUser: el índice único de email es sparse
  // (ignora documentos SIN el campo), pero "" sí cuenta como valor
  // duplicado. Acá además hay que poder BORRAR un correo existente (ej.
  // si el admin cambia un usuario de MANAGER a CASHIER) — `$set` con
  // `undefined` no lo logra (Mongoose lo descarta del update en vez de
  // desasignarlo), así que se necesita `$unset` explícito en ese caso.
  const update: any = email ? { $set: { ...doc, email, active: req.body.active } } : { $set: { ...doc, active: req.body.active }, $unset: { email: "" } };

  const user = await User.findByIdAndUpdate(req.params.id, update, { new: true }).select("-password -pin");
  if (!user) return res.status(404).json({ error: "Usuario no encontrado" });
  return res.json(user);
}

/* --------------------------- Dashboard / Ventas --------------------------- */

export async function getDashboardKpis(req: Request, res: Response) {
  const branchId = resolveBranchFilter(req);
  const startOfDay = getStartOfTodayColombia();

  const matchStage: any = { createdAt: { $gte: startOfDay } };
  if (branchId) matchStage.branchId = branchId;

  const [todaySummary, byChannel, dianStatusBreakdown] = await Promise.all([
    Sale.aggregate([
      { $match: matchStage },
      { $group: { _id: null, total: { $sum: "$total" }, count: { $sum: 1 } } },
    ]),
    Sale.aggregate([
      { $match: matchStage },
      { $group: { _id: "$orderType", total: { $sum: "$total" }, count: { $sum: 1 } } },
    ]),
    Sale.aggregate([
      { $match: matchStage },
      { $group: { _id: "$dianStatus", count: { $sum: 1 } } },
    ]),
  ]);

  return res.json({
    totalToday: todaySummary[0]?.total || 0,
    salesCountToday: todaySummary[0]?.count || 0,
    byChannel,
    dianStatusBreakdown,
  });
}

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  CASH: "Efectivo",
  CARD: "Tarjetas / Datáfono",
  NEQUI: "Nequi / Daviplata",
  DELIVERY_APP: "Delivery Apps (Rappi/DiDi)",
};

/**
 * GET /api/admin/dashboard/metrics -> datos para el rediseño del dashboard
 * (ver admin-frontend/docs/ADMIN_DASHBOARD.md). A diferencia de
 * getDashboardKpis (arriba, fijo al día de hoy), este acepta un rango de
 * fechas (`from`/`to`) elegido por el filtro superior del dashboard.
 *
 * `discountTotal` e `ivaTotal` en el resumen siempre son 0 — este sistema
 * no tiene un modelo de descuentos ni distingue IVA (19%) de Impoconsumo
 * (8%) por producto hoy (todas las ventas usan una tasa plana del 8%, ver
 * punto de arquitectura sobre el placeholder de impuesto en CLAUDE.md) —
 * se devuelven en 0 en vez de inventar un cálculo que no existe realmente.
 * Lo mismo para las filas "Crédito / Cuentas por Cobrar" y "Devoluciones /
 * Notas Crédito" de `paymentMethods`: no hay modelo de crédito ni de
 * notas crédito en este sistema, así que quedan en 0 a propósito — son
 * filas requeridas por el spec del dashboard, no datos fabricados.
 *
 * `summary` también trae `totalPurchases`/`totalExpenses`/`profitability`
 * (ver punto 54 de CLAUDE.md) — mismo rango/sede que el resto de este
 * endpoint, agregados de `Purchase`/`Expense` sin filtro de estado (ninguno
 * de los dos modelos tiene un concepto de "cancelado", a diferencia de
 * `Sale.status`).
 */
export async function getDashboardMetrics(req: Request, res: Response) {
  const branchId = resolveBranchFilter(req);
  const { from, to } = req.query;

  const start = from ? startOfLocalDay(String(from)) : getStartOfTodayColombia();
  const end = to ? endOfLocalDay(String(to)) : new Date();

  // `$match` en un pipeline de agregación NO castea tipos como sí lo hace
  // Model.find() — comparar el string de resolveBranchFilter contra el
  // ObjectId real guardado en Mongo nunca matchea nada. Sale.aggregate
  // con un branchId específico devolvía 0 resultados por esto (bug real
  // ya corregido) mientras que "todas las sedes" funcionaba porque ahí
  // ni siquiera se agrega el filtro.
  const branchObjectId = branchId ? new Types.ObjectId(branchId) : undefined;

  const saleMatch: any = { status: "ACTIVE", createdAt: { $gte: start, $lte: end } };
  if (branchObjectId) saleMatch.branchId = branchObjectId;

  const expenseMatch: any = { createdAt: { $gte: start, $lte: end } };
  if (branchObjectId) expenseMatch.branchId = branchObjectId;

  const purchaseMatch: any = { createdAt: { $gte: start, $lte: end } };
  if (branchObjectId) purchaseMatch.branchId = branchObjectId;

  // Widget 1 solo tiene sentido por HORA cuando el rango es un único día
  // (Hoy/Ayer) — agregar por hora a través de VARIOS días junta el mismo
  // horario de días distintos en una sola barra, lo que no responde "¿qué
  // pasó en cada día del rango?". Para semana/mes/rango personalizado
  // (más de un día calendario) se agrega por DÍA en su lugar.
  const isSingleDay = !from || !to || String(from) === String(to);
  const timelineGranularity: "hour" | "day" = isSingleDay ? "hour" : "day";

  const [summaryAgg, timelineAgg, topProductsAgg, expensesAgg, paymentMethodsAgg, purchasesAgg] = await Promise.all([
    Sale.aggregate([
      { $match: saleMatch },
      {
        $group: {
          _id: null,
          grossTotal: { $sum: "$subtotal" },
          impoconsumoTotal: { $sum: "$tax" },
          netTotal: { $sum: "$total" },
          totalTransactions: { $sum: 1 },
        },
      },
    ]),
    isSingleDay
      ? Sale.aggregate([
          { $match: saleMatch },
          { $group: { _id: { $hour: { date: "$createdAt", timezone: "America/Bogota" } }, total: { $sum: "$total" } } },
        ])
      : Sale.aggregate([
          { $match: saleMatch },
          {
            $group: {
              _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "America/Bogota" } },
              total: { $sum: "$total" },
            },
          },
        ]),
    Sale.aggregate([
      { $match: saleMatch },
      { $unwind: "$items" },
      { $group: { _id: "$items.name", quantity: { $sum: "$items.quantity" } } },
      { $sort: { quantity: -1 } },
    ]),
    Expense.aggregate([
      { $match: expenseMatch },
      { $group: { _id: "$category", amount: { $sum: "$amount" } } },
      { $sort: { amount: -1 } },
    ]),
    Sale.aggregate([
      { $match: saleMatch },
      { $group: { _id: "$paymentMethod", amount: { $sum: "$total" } } },
    ]),
    Purchase.aggregate([{ $match: purchaseMatch }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
  ]);

  const summary = summaryAgg[0] || { grossTotal: 0, impoconsumoTotal: 0, netTotal: 0, totalTransactions: 0 };
  const averageTicket = summary.totalTransactions > 0 ? summary.netTotal / summary.totalTransactions : 0;

  const salesTimeline: { label: string; total: number }[] = [];
  if (isSingleDay) {
    // 00:00–23:00, en 0 cualquier hora sin ventas — para que el eje X
    // siempre tenga el mismo rango sin importar cuántas ventas hubo.
    // Antes empezaba en 05:00 asumiendo que la panadería nunca vende de
    // madrugada — una venta real con `createdAt` entre las 00:00 y las
    // 04:59 hora Bogotá (bug real ya corregido: pasaba, por ejemplo, con
    // ventas registradas justo después de medianoche) quedaba fuera del
    // loop y jamás se graficaba, aunque sí contaba en `summaryAgg` — el
    // widget mostraba "No hay ventas registradas" con el resumen de al
    // lado mostrando totales reales.
    const totalByHour = new Map(timelineAgg.map((h: any) => [h._id, h.total]));
    for (let hour = 0; hour <= 23; hour++) {
      salesTimeline.push({ label: `${String(hour).padStart(2, "0")}:00`, total: totalByHour.get(hour) || 0 });
    }
  } else {
    // Un punto por cada día calendario del rango (en 0 si ese día no tuvo
    // ventas), formateado corto para que quepan varias semanas en el eje X.
    const totalByDay = new Map(timelineAgg.map((d: any) => [d._id, d.total]));
    const pad = (n: number) => String(n).padStart(2, "0");
    const cursor = new Date(start);
    // `start`/`end` son instantes UTC que representan medianoche/fin de día
    // en Bogotá (ver dateRange.ts) — por eso acá se usan los getters/setters
    // **UTC** de `Date`, no los "locales" (`getFullYear`/`getDate`/etc, que
    // dependen de la zona horaria del proceso de Node): el instante ya
    // codifica el día correcto de Bogotá, así que leerlo/avanzarlo en UTC da
    // el mismo resultado sin importar en qué timezone corra el servidor.
    while (cursor <= end) {
      const key = `${cursor.getUTCFullYear()}-${pad(cursor.getUTCMonth() + 1)}-${pad(cursor.getUTCDate())}`;
      const label = cursor.toLocaleDateString("es-CO", {
        day: "2-digit",
        month: "short",
        timeZone: COLOMBIA_TIME_ZONE,
      });
      salesTimeline.push({ label, total: totalByDay.get(key) || 0 });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
  }

  // Top 5 productos por cantidad vendida, el resto agrupado en "Otros".
  const totalQuantity = topProductsAgg.reduce((sum: number, p: any) => sum + p.quantity, 0);
  const top5 = topProductsAgg.slice(0, 5);
  const othersQuantity = topProductsAgg.slice(5).reduce((sum: number, p: any) => sum + p.quantity, 0);
  const topProducts = top5.map((p: any) => ({
    name: p._id,
    quantity: p.quantity,
    percentage: totalQuantity > 0 ? Math.round((p.quantity / totalQuantity) * 1000) / 10 : 0,
  }));
  if (othersQuantity > 0) {
    topProducts.push({
      name: "Otros",
      quantity: othersQuantity,
      percentage: totalQuantity > 0 ? Math.round((othersQuantity / totalQuantity) * 1000) / 10 : 0,
    });
  }

  const totalExpenses = expensesAgg.reduce((sum: number, e: any) => sum + e.amount, 0);
  const expensesByCategory = expensesAgg.map((e: any) => ({
    category: e._id,
    amount: e.amount,
    percentage: totalExpenses > 0 ? Math.round((e.amount / totalExpenses) * 1000) / 10 : 0,
  }));

  const totalPurchases = purchasesAgg[0]?.sum || 0;
  // Rentabilidad = ventas netas - compras - gastos, del mismo rango/sede
  // que el resto del dashboard. No es una utilidad contable formal (no
  // resta costo de mercancía vendida vía kardex, que no existe todavía —
  // ver "Pendiente conocido" en el CLAUDE.md raíz sobre el BOM/recipe sin
  // descuento de stock) — es la lectura simple "cuánto entró menos cuánto
  // salió" que el negocio pidió para este widget.
  const profitability = summary.netTotal - totalPurchases - totalExpenses;

  const amountByMethod = new Map(paymentMethodsAgg.map((m: any) => [m._id, m.amount]));
  const paymentMethods = [
    ...Object.entries(PAYMENT_METHOD_LABELS).map(([key, label]) => ({
      method: label,
      amount: amountByMethod.get(key) || 0,
    })),
    { method: "Crédito / Cuentas por Cobrar", amount: 0 },
    { method: "Devoluciones / Notas Crédito", amount: 0 },
  ];

  return res.json({
    summary: {
      grossTotal: summary.grossTotal,
      discountTotal: 0,
      impoconsumoTotal: summary.impoconsumoTotal,
      ivaTotal: 0,
      netTotal: summary.netTotal,
      averageTicket,
      totalTransactions: summary.totalTransactions,
      totalPurchases,
      totalExpenses,
      profitability,
    },
    salesTimeline,
    timelineGranularity,
    topProducts,
    expensesByCategory,
    paymentMethods,
  });
}

export async function listSales(req: Request, res: Response) {
  const { from, to, dianStatus, orderType, category, paymentMethod, paymentStatus, cashierId, search } = req.query;
  const branchId = resolveBranchFilter(req);
  const filter: any = {};
  // Casteados a `Types.ObjectId` desde el principio — `$match` en el
  // `aggregate` de `totalAmount` (más abajo) no castea un string como sí
  // lo hace `Model.find()`/`countDocuments()`, mismo gotcha ya corregido
  // en `listPurchasesAdmin`/`listExpenses` (ver punto 15) y en
  // `getDashboardMetrics`/`createSaleAdmin` (puntos 25/37). `find`/
  // `countDocuments` aceptan un ObjectId real igual que un string, así que
  // no hace falta un filtro aparte solo para el aggregate.
  if (branchId) filter.branchId = new Types.ObjectId(branchId);
  if (dianStatus) filter.dianStatus = dianStatus;
  if (orderType) filter.orderType = orderType;
  if (category) filter.category = category;
  if (paymentMethod) filter.paymentMethod = paymentMethod;
  // Filtro nuevo para la vista de "pendientes DiDi/Rappi" del miércoles de
  // liquidación (ver punto 53 de admin-frontend/CLAUDE.md) — combinado con
  // paymentMethod=DELIVERY_APP en el frontend, aunque este filtro por sí
  // solo también sirve para cualquier otro uso futuro de paymentStatus.
  if (paymentStatus) filter.paymentStatus = paymentStatus;
  if (cashierId) filter.cashierId = new Types.ObjectId(String(cashierId));
  // `startOfLocalDay`/`endOfLocalDay` (ver punto 33/24 de CLAUDE.md) — antes
  // esto usaba `new Date(string)` a secas, que interpreta el string como
  // medianoche UTC, no Bogotá; el filtro de fecha nuevo del frontend
  // (búsqueda por día) heredaría ese mismo bug si se dejaba tal cual.
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = startOfLocalDay(String(from));
    if (to) filter.createdAt.$lte = endOfLocalDay(String(to));
  }
  // Búsqueda por CUFE o por ID de venta (completo o parcial, ej. el ID corto
  // de 8 caracteres que se muestra en la tabla/recibo — mismo criterio que
  // `invoiceId` en printerService.ts). `$expr`/`$regexMatch` sobre
  // `$toString: "$_id"` deja buscar un fragmento del ObjectId sin necesitar
  // un campo aparte que lo almacene ya como string.
  if (search) {
    const term = String(search).trim();
    if (term) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { cufe: { $regex: escaped, $options: "i" } },
        { $expr: { $regexMatch: { input: { $toString: "$_id" }, regex: escaped, options: "i" } } },
      ];
    }
  }

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));

  const [sales, total, totalAmountAgg] = await Promise.all([
    Sale.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate("branchId", "name address phone")
      .populate("cashierId", "name"),
    Sale.countDocuments(filter),
    // La UI muestra un total en dinero de TODAS las ventas del filtro (no
    // solo la página actual), mismo patrón que listPurchasesAdmin/
    // listExpenses (ver punto 15) — pero excluyendo `status: "CANCELLED"`:
    // una venta cancelada no es dinero real entrando a caja (mismo
    // criterio que `getDashboardMetrics`, que también solo suma
    // `status: "ACTIVE"`), así que sumarla infla el total con dinero que
    // nunca se cobró. `data`/`total` (arriba) SÍ siguen incluyendo
    // canceladas — la tabla necesita mostrarlas (con su badge "Cancelada",
    // ver Ventas.tsx), solo el total en dinero las excluye.
    Sale.aggregate([
      { $match: { ...filter, status: "ACTIVE" } },
      { $group: { _id: null, sum: { $sum: "$total" } } },
    ]),
  ]);
  const totalAmount = totalAmountAgg[0]?.sum || 0;

  return res.json({
    data: sales,
    total,
    totalAmount,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

// Lookup liviano para el filtro "Usuario" de /ventas: solo devuelve usuarios
// que efectivamente tienen al menos una venta registrada dentro del filtro
// de sede vigente (a diferencia de `listCashiersForClosures`, que solo
// devuelve rol CASHIER — acá también deben poder aparecer un ADMIN/MANAGER
// que haya registrado una venta manualmente desde "+ Agregar venta", ver
// `createSaleAdmin`). No pagina — es para poblar un <select>, no una tabla.
export async function listSaleUsers(req: Request, res: Response) {
  const branchId = resolveBranchFilter(req);
  const filter: any = {};
  if (branchId) filter.branchId = branchId;

  const cashierIds = await Sale.distinct("cashierId", filter);
  const users = await User.find({ _id: { $in: cashierIds } })
    .select("name role")
    .sort({ name: 1 })
    .lean();

  return res.json(users);
}

/**
 * POST /api/admin/sales — venta registrada manualmente desde el panel admin
 * (ej. venta telefónica, corrección de caja), a diferencia de
 * POST /api/pos/sales (posController.ts) que la crea el cajero desde su
 * sesión de PIN. A diferencia de ese flujo, acá SÍ se valida y descuenta
 * `ProductStock` — el admin puede vender de cualquier sede sin pasar por el
 * conteo de caja del cajero, así que no hay otro punto que garantice que el
 * stock reportado siga siendo real.
 */
export async function createSaleAdmin(req: Request, res: Response) {
  const { items, paymentMethod, customer } = req.body;
  let { branchId } = req.body;
  const THIRTY_MINUTES = 2 * 60 * 1000;
  const MAX_GROUP_1 = 509000;
  let category: string = "REGULAR";
  let hasSpace: boolean = false;
  let thirtyMinutesPassed: boolean = false;

  // Un GERENTE solo puede registrar ventas de su propia sede, sin importar
  // qué branchId mande el body (mismo principio que resolveBranchFilter,
  // aplicado acá a una escritura en vez de un filtro de lectura).
  if (req.admin?.role === "MANAGER") branchId = req.admin.branchId;

  if (!branchId) {
    return res.status(400).json({ error: "Selecciona la sede donde se realizó la venta" });
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "La venta debe tener al menos un producto" });
  }
  if (!paymentMethod) {
    return res.status(400).json({ error: "Selecciona el método de pago" });
  }

  const productIds = items.map((it: any) => it.productId);
  const [products, stocks] = await Promise.all([
    Product.find({ _id: { $in: productIds }, active: true }).lean(),
    ProductStock.find({ productId: { $in: productIds }, branchId }).lean(),
  ]);
  const productById = new Map(products.map((p) => [String(p._id), p]));
  const stockByProduct = new Map(stocks.map((s) => [String(s.productId), s.quantity]));

  const insufficient: string[] = [];
  for (const it of items as any[]) {
    const product = productById.get(String(it.productId));
    const quantity = Number(it.quantity) || 0;
    if (!product) {
      insufficient.push("Producto no encontrado");
      continue;
    }
    const available = stockByProduct.get(String(it.productId)) || 0;
    if (quantity <= 0 || quantity > available) {
      insufficient.push(`${product.name} (disponible: ${available})`);
    }
  }
  if (insufficient.length > 0) {
    return res.status(422).json({
      error: "STOCK_INSUFICIENTE",
      message: `No hay stock suficiente para: ${insufficient.join(", ")}`,
    });
  }

  const saleItems = (items as any[]).map((it) => {
    const product = productById.get(String(it.productId))!;
    const quantity = Number(it.quantity);
    return {
      productId: product._id,
      name: product.name,
      quantity,
      price: product.price,
      total: product.price * quantity,
    };
  });

  const subtotal = saleItems.reduce((acc, it) => acc + it.total, 0);
  const tax = Math.round(subtotal * 0.08);
  const total = saleItems.reduce((acc, it) => acc + it.total, 0);;

  /**
   * 
   

  const requiresNominal = dianService.requiresNominalInvoice(total);
  if (requiresNominal && (!customer || !customer.document)) {
    return res.status(422).json({
      error: "REQUIERE_DATOS_CLIENTE",
      message:
        "La venta supera el tope de consumidor final. Se requieren datos del comprador para Factura Electrónica Nominal.",
    });
  }
    */

  const branchInfo = await Branch.findById(branchId);
  if (!branchInfo) {
    return res.status(400).json({ error: "Sede no encontrada" });
  }

  if (branchInfo.dianResponsible === true) {
      const now = Date.now();

      // COLOMBIA_TIME_ZONE/COLOMBIA_UTC_OFFSET vienen de utils/dateRange.ts —
      // antes se redeclaraban acá mismo (duplicado de las mismas constantes),
      // ahora reutilizan el único punto de verdad del backend.
      const startOfTodayColombia = getStartOfTodayColombia();

      const lastGroup1Item = await Sale.findOne({
          branchId,
          category: "SPECIAL",
          createdAt: { $gte: startOfTodayColombia },
        }).sort({ createdAt: -1 });

      // `$match` en un pipeline de agregación NO castea tipos como sí lo
      // hace Model.find()/findOne() — comparar el string `branchId` contra
      // el ObjectId real guardado en Mongo no matchea nada (mismo gotcha ya
      // documentado en getDashboardMetrics), así que hay que castearlo a
      // mano acá.
      const group1SumResult = await Sale.aggregate([
          {
            $match: {
              branchId: new Types.ObjectId(branchId),
              category: "SPECIAL",
              createdAt: { $gte: startOfTodayColombia },
            },
          },
          { $group: { _id: null, total: { $sum: "$total" } } },
      ]);

      const group1Total = group1SumResult.length ? group1SumResult[0].total : 0;
      const newTotal = Number(group1Total) + Number(total);

      hasSpace = newTotal < MAX_GROUP_1;
      

      thirtyMinutesPassed =
        !lastGroup1Item ||
        now - lastGroup1Item.createdAt.getTime() >= THIRTY_MINUTES;

      category = hasSpace && thirtyMinutesPassed ? "SPECIAL" : "REGULAR";
  }


  // Crea la venta ANTES de descontar stock — si `Sale.create` fallara (o el
  // proceso muriera) después de descontar y antes de crear el registro,
  // quedaría stock perdido sin ninguna venta que lo explique. Con este
  // orden, en el peor caso el fallo ocurre después de tener el registro de
  // venta (se puede reconciliar a mano), nunca antes.
  const sale = await Sale.create({
    branchId,
    cashierId: req.admin!.userId,
    orderType: "POS_COUNTER",
    items: saleItems,
    paymentMethod,
    paymentStatus: resolvePaymentStatus(paymentMethod),
    subtotal,
    tax,
    total,
    customer,
    invoiceType: "POS_DOC",
    //invoiceType: requiresNominal ? "FACTURA_NOMINAL" : "POS_DOC",
    dianStatus: "PENDING",
    offlineCreated: false,
    stockDecremented: true,
    category,
  });

  // El filtro `quantity: { $gte }` es una segunda defensa (no hay
  // transacciones multi-documento en este proyecto) ante una venta
  // concurrente que haya vaciado el stock justo entre la validación de
  // arriba y este punto.
  for (const it of saleItems) {
    await ProductStock.findOneAndUpdate(
      { productId: it.productId, branchId, quantity: { $gte: it.quantity } },
      { $inc: { quantity: -it.quantity } }
    );
  }

  // A propósito NO se espera esta promesa: si Redis/BullMQ está lento o
  // caído, la respuesta al cliente no debe quedar bloqueada por eso (ver
  // punto 2 de CLAUDE.md — "nunca debe tumbar la respuesta", "responde al
  // cliente inmediatamente"). Un `await` acá sí lo violaba: si el enqueue
  // tardaba más que el timeout del cliente (8s en el admin-frontend), el
  // admin veía un error aunque la venta ya se hubiera creado y el stock ya
  // se hubiera descontado correctamente. El job de reconciliación
  // (`reconcilePendingDianSales.ts`) igual reencola cualquier venta que
  // quede `dianStatus: PENDING` sin job vivo, así que perder este enqueue
  // puntual no deja una venta huérfana.
  if(branchInfo.dianResponsible === true && hasSpace && thirtyMinutesPassed){
    enqueueSaleForDianEmission(String(sale._id)).catch((err) => {
      console.error(`[createSaleAdmin] No se pudo encolar la venta ${sale._id} para DIAN:`, err);
    });
  }
  

  // Igual que el enqueue de DIAN arriba: fire-and-forget, nunca bloquea la
  // respuesta (ver docs/GOOGLE_SHEETS_INTEGRATION.md y utils/sheetsSync.ts).
  logSaleToSheets(sale).catch((err) => {
    console.error(`[createSaleAdmin] No se pudo sincronizar la venta ${sale._id} a Sheets:`, err);
  });
  for (const it of saleItems) {
    syncInventoryToSheets(it.productId).catch((err) => {
      console.error(`[createSaleAdmin] No se pudo sincronizar inventario de ${it.productId} a Sheets:`, err);
    });
  }

  // Poblado antes de responder para que el recibo (SaleReceipt.tsx) pueda
  // mostrar nombre/dirección/teléfono de la sede y nombre del vendedor sin
  // una segunda llamada — mismo shape que devuelve listSales.
  await sale.populate("branchId", "name address phone");
  await sale.populate("cashierId", "name");

  return res.status(201).json(sale);
}

/**
 * PUT /api/admin/sales/:id — edita SOLO metadata de una venta ya creada
 * (método de pago, datos del cliente, canal, categoría). A propósito NO
 * permite tocar items/cantidades/montos: esos ya movieron `ProductStock` y
 * recalcularlos de forma segura (deltas por producto, posibles nuevas
 * faltas de stock, etc.) es un problema aparte que no se pidió resolver
 * acá — ver punto 19 de CLAUDE.md.
 */
export async function updateSaleAdmin(req: Request, res: Response) {
  const { paymentMethod, customer, orderType, category } = req.body;

  const sale = await Sale.findById(req.params.id);
  if (!sale) return res.status(404).json({ error: "Venta no encontrada" });

  if (req.admin?.role === "MANAGER" && String(sale.branchId) !== req.admin.branchId) {
    return res.status(403).json({ error: "No tienes acceso a esta venta" });
  }
  if (sale.status === "CANCELLED") {
    return res.status(400).json({ error: "No se puede editar una venta cancelada" });
  }

  // Si el método de pago cambia de verdad (no solo se reenvía el mismo
  // valor que ya tenía), recalcula `paymentStatus` para que no quede
  // desincronizado — ver `resolvePaymentStatus` y punto 34 de CLAUDE.md. Si
  // vuelve a un método que no es DELIVERY_APP, limpia `settlementDate`: la
  // liquidación anterior (si la hubo) ya no aplica a este método nuevo.
  if (paymentMethod && paymentMethod !== sale.paymentMethod) {
    sale.paymentMethod = paymentMethod;
    sale.paymentStatus = resolvePaymentStatus(paymentMethod);
    if (sale.paymentStatus === "PENDING_PAYMENT") sale.settlementDate = undefined;
  }
  if (customer !== undefined) sale.customer = customer;
  if (orderType) sale.orderType = orderType;
  if (category === "REGULAR" || category === "SPECIAL") sale.category = category;
  await sale.save();

  return res.json(sale);
}

/**
 * PATCH /api/admin/sales/:id/confirm-payment — marca como liquidada una
 * venta DELIVERY_APP (Rappi/DiDi) que había quedado `PENDING_PAYMENT` al
 * crearse (ver `resolvePaymentStatus` en el modelo Sale). Es el paso manual
 * de conciliación: el admin/gerente lo confirma cuando el agregador
 * efectivamente deposita el dinero a la cuenta bancaria — no hay forma
 * automática de saberlo desde este sistema (no hay integración con el
 * agregador ni con el banco). Ver punto 34 de CLAUDE.md.
 */
export async function confirmSalePayment(req: Request, res: Response) {
  const sale = await Sale.findById(req.params.id);
  if (!sale) return res.status(404).json({ error: "Venta no encontrada" });

  if (req.admin?.role === "MANAGER" && String(sale.branchId) !== req.admin.branchId) {
    return res.status(403).json({ error: "No tienes acceso a esta venta" });
  }
  if (sale.paymentStatus !== "PENDING_PAYMENT") {
    return res.status(400).json({ error: "Esta venta no tiene un pago pendiente de confirmar" });
  }

  const { settlementReference } = req.body as { settlementReference?: string };

  sale.paymentStatus = "COMPLETED";
  sale.settlementDate = new Date();
  if (settlementReference) sale.settlementReference = settlementReference;
  await sale.save();

  logPaymentConfirmationToSheets(sale).catch((err) => {
    console.error(`[confirmSalePayment] No se pudo sincronizar la confirmación de ${sale._id} a Sheets:`, err);
  });

  await sale.populate("branchId", "name address phone");
  await sale.populate("cashierId", "name");

  return res.json(sale);
}

/**
 * PATCH /api/admin/sales/confirm-payment-bulk
 * `{ saleIds: string[], settlementReference?: string }` — confirmación en
 * bloque del pago de varias ventas DELIVERY_APP a la vez (miércoles de
 * liquidación DiDi/Rappi, ver punto 53 de admin-frontend/CLAUDE.md). Mismo
 * criterio fila por fila que `confirmSalePayment` (arriba) — no es una
 * sola query masiva de Mongo (`updateMany`), porque cada venta necesita su
 * propio chequeo de sede (MANAGER) y su propio estado antes de aceptarla;
 * un `updateMany` con un filtro compartido no puede reportar CUÁL id
 * falló y por qué, y esa granularidad es justo lo que la UI necesita para
 * mostrarle al admin cuáles sí y cuáles no se confirmaron.
 */
export async function confirmSalePaymentBulk(req: Request, res: Response) {
  const { saleIds, settlementReference } = req.body as { saleIds?: string[]; settlementReference?: string };

  if (!Array.isArray(saleIds) || saleIds.length === 0) {
    return res.status(400).json({ error: "Selecciona al menos una venta para confirmar" });
  }

  const confirmed: string[] = [];
  const skipped: { id: string; reason: string }[] = [];

  for (const id of saleIds) {
    const sale = await Sale.findById(id);
    if (!sale) {
      skipped.push({ id, reason: "Venta no encontrada" });
      continue;
    }
    if (req.admin?.role === "MANAGER" && String(sale.branchId) !== req.admin.branchId) {
      skipped.push({ id, reason: "Sin acceso a esta venta" });
      continue;
    }
    if (sale.paymentStatus !== "PENDING_PAYMENT") {
      skipped.push({ id, reason: "No tiene un pago pendiente de confirmar" });
      continue;
    }

    sale.paymentStatus = "COMPLETED";
    sale.settlementDate = new Date();
    if (settlementReference) sale.settlementReference = settlementReference;
    await sale.save();
    confirmed.push(id);

    logPaymentConfirmationToSheets(sale).catch((err) => {
      console.error(`[confirmSalePaymentBulk] No se pudo sincronizar la confirmación de ${sale._id} a Sheets:`, err);
    });
  }

  return res.json({ confirmed, skipped });
}

/**
 * POST /api/admin/sales/:id/cancel — cancela (soft-delete) una venta. El
 * registro NO se borra: queda visible en /ventas con `status: CANCELLED`,
 * para no perder el rastro contable. Si la venta descontó stock al
 * crearse (`stockDecremented`, ver el modelo Sale — hoy solo pasa con
 * ventas creadas desde este mismo panel, no desde el POS del cajero), se
 * restaura esa cantidad a `ProductStock`.
 */
export async function cancelSaleAdmin(req: Request, res: Response) {
  const sale = await Sale.findById(req.params.id);
  if (!sale) return res.status(404).json({ error: "Venta no encontrada" });

  if (req.admin?.role === "MANAGER" && String(sale.branchId) !== req.admin.branchId) {
    return res.status(403).json({ error: "No tienes acceso a esta venta" });
  }
  if (sale.status === "CANCELLED") {
    return res.status(400).json({ error: "La venta ya está cancelada" });
  }

  if (sale.stockDecremented) {
    await Promise.all(
      sale.items.map((it) =>
        ProductStock.findOneAndUpdate(
          { productId: it.productId, branchId: sale.branchId },
          { $inc: { quantity: it.quantity } },
          { upsert: true }
        )
      )
    );
    for (const it of sale.items) {
      syncInventoryToSheets(it.productId).catch((err) => {
        console.error(`[cancelSaleAdmin] No se pudo sincronizar inventario de ${it.productId} a Sheets:`, err);
      });
    }
  }

  sale.status = "CANCELLED";
  await sale.save();

  return res.json(sale);
}

/* --------------------------- CPP / CPC --------------------------- */

export async function listPayables(req: Request, res: Response) {
  const { status } = req.query;
  const branchId = resolveBranchFilter(req);
  const filter: any = {};
  if (branchId) filter.branchId = branchId;
  if (status) filter.status = status;
  const payables = await AccountPayable.find(filter).sort({ dueDate: 1 });
  return res.json(payables);
}

export async function createPayable(req: Request, res: Response) {
  const payable = await AccountPayable.create(req.body);
  return res.status(201).json(payable);
}

export async function listReceivables(req: Request, res: Response) {
  const { status } = req.query;
  const branchId = resolveBranchFilter(req);
  const filter: any = {};
  if (branchId) filter.branchId = branchId;
  if (status) filter.status = status;
  const receivables = await AccountReceivable.find(filter).sort({ dueDate: 1 });
  return res.json(receivables);
}

export async function createReceivable(req: Request, res: Response) {
  const receivable = await AccountReceivable.create(req.body);
  return res.status(201).json(receivable);
}

/* --------------------------- Gastos --------------------------- */

export async function listExpenses(req: Request, res: Response) {
  const { category, from, to } = req.query;
  const branchId = resolveBranchFilter(req);
  const filter: any = {};
  // Mismo gotcha de `$match` sin castear ObjectId que en
  // `listPurchasesAdmin`/`getDashboardMetrics` — `totalAmount` (más abajo,
  // vía `Expense.aggregate`) daba 0 en cuanto se filtraba por una sede
  // específica. `find`/`countDocuments` toleran el string sin problema; el
  // `aggregate` no.
  if (branchId) filter.branchId = new Types.ObjectId(branchId);
  if (category) filter.category = category;
  // `startOfLocalDay`/`endOfLocalDay` (ver punto 33/24 de CLAUDE.md) — mismo
  // patrón que `listSales`/`listPurchasesAdmin`, nunca `new Date(string)` a
  // secas para un filtro de fecha.
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = startOfLocalDay(String(from));
    if (to) filter.createdAt.$lte = endOfLocalDay(String(to));
  }

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));

  const [expenses, total, totalAmountAgg] = await Promise.all([
    Expense.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate("branchId", "name"),
    Expense.countDocuments(filter),
    // La UI muestra un total en dinero de TODOS los gastos del filtro (no
    // solo la página actual), mismo patrón que listPurchasesAdmin.
    Expense.aggregate([{ $match: filter }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
  ]);
  const totalAmount = totalAmountAgg[0]?.sum || 0;

  return res.json({
    data: expenses,
    total,
    totalAmount,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

export async function createExpense(req: Request, res: Response) {
  const { branchId, category, concept, amount } = req.body;
  if (!branchId || !category || !concept || !amount) {
    return res.status(400).json({ error: "Sede, categoría, concepto y monto son obligatorios" });
  }

  const expense = await Expense.create({
    branchId,
    category,
    concept,
    amount,
    registeredBy: req.admin!.userId,
  });

  logExpenseToSheets(expense).catch((err) => {
    console.error(`[createExpense] No se pudo sincronizar el gasto ${expense._id} a Sheets:`, err);
  });

  return res.status(201).json(expense);
}

/**
 * PUT /api/admin/expenses/:id — edita un gasto ya registrado. A diferencia
 * de Purchase (punto 16 de CLAUDE.md), Expense no tiene `productId`/stock
 * que ajustar — es un simple patch de categoría/concepto/monto, sin
 * efectos secundarios sobre inventario. NO se vuelve a sincronizar a
 * Google Sheets: `OPERATIONAL_LOGS` es append-only (ver punto 21), así que
 * la fila que ya se logueó al crear el gasto sigue mostrando los datos
 * originales — editar acá no la reescribe.
 */
export async function updateExpense(req: Request, res: Response) {
  const { category, concept, amount } = req.body as {
    category?: string;
    concept?: string;
    amount?: number;
  };

  const expense = await Expense.findById(req.params.id);
  if (!expense) return res.status(404).json({ error: "Gasto no encontrado" });

  if (req.admin?.role === "MANAGER" && String(expense.branchId) !== req.admin.branchId) {
    return res.status(403).json({ error: "No tienes acceso a este gasto" });
  }

  if (amount !== undefined && (!Number.isFinite(Number(amount)) || Number(amount) <= 0)) {
    return res.status(400).json({ error: "El monto debe ser mayor a 0" });
  }

  if (category !== undefined) expense.category = category as IExpense["category"];
  if (concept !== undefined) expense.concept = concept;
  if (amount !== undefined) expense.amount = Number(amount);

  await expense.save();
  return res.json(expense);
}

/**
 * DELETE /api/admin/expenses/:id — borra un gasto. A diferencia de Sale
 * (soft-cancel, punto 22) o Purchase (revierte stock si aplica, punto 16),
 * Expense no tiene ningún estado ni inventario que reconciliar — es un
 * borrado real (`deleteOne`), no un `status: CANCELLED`. No existe un
 * concepto de "reactivar" un gasto eliminado.
 */
export async function deleteExpense(req: Request, res: Response) {
  const expense = await Expense.findById(req.params.id);
  if (!expense) return res.status(404).json({ error: "Gasto no encontrado" });

  if (req.admin?.role === "MANAGER" && String(expense.branchId) !== req.admin.branchId) {
    return res.status(403).json({ error: "No tienes acceso a este gasto" });
  }

  await expense.deleteOne();
  return res.status(204).send();
}
