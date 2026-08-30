import { Request, Response } from "express";
import { Types } from "mongoose";
import { Purchase } from "../models/Purchase";
import { Product } from "../models/Product";
import { ProductStock } from "../models/ProductStock";
import { User } from "../models/User";
import { resolveBranchFilter } from "./adminController";
import { syncInventoryToSheets, logPurchaseToSheets } from "../utils/sheetsSync";
import { getCashierShiftStart } from "../utils/shiftRange";
import { startOfLocalDay, endOfLocalDay } from "../utils/dateRange";

/**
 * POST /api/pos/purchases -> registrar una compra del día (cajero).
 *
 * Reemplaza el flujo informal anterior (proveedor/concepto/monto + foto de
 * recibo, sin vínculo a inventario): ahora exige producto + cantidad, igual
 * que `createPurchaseAdmin`, y agrega stock en `ProductStock` de la sede
 * del cajero. `branchId` nunca se toma del body — siempre
 * `posSession.branchId`, para que un cajero no pueda registrar stock en
 * otra sede aunque lo intente.
 */
export async function createPurchase(req: Request, res: Response) {
  const posSession = req.posSession!;
  const { productId, supplierName, concept, amount, quantity } = req.body;

  if (!productId || !supplierName || !amount || !quantity) {
    return res.status(400).json({ error: "Producto, proveedor, cantidad y monto son requeridos" });
  }
  const parsedQuantity = Number(quantity);
  const parsedAmount = Number(amount);
  if (!(parsedQuantity > 0) || !(parsedAmount > 0)) {
    return res.status(400).json({ error: "Cantidad y monto deben ser mayores a 0" });
  }

  const product = await Product.findById(productId);
  if (!product) return res.status(404).json({ error: "Producto no encontrado" });

  const purchase = await Purchase.create({
    branchId: posSession.branchId,
    registeredBy: posSession.cashierId,
    supplierName,
    concept: concept || `Compra de stock: ${product.name}`,
    amount: parsedAmount,
    paymentMethod: "CASH",
    productId: product._id,
    quantity: parsedQuantity,
  });

  await ProductStock.findOneAndUpdate(
    { productId: product._id, branchId: posSession.branchId },
    { $inc: { quantity: parsedQuantity } },
    { upsert: true }
  );

  logPurchaseToSheets(purchase).catch((err) => {
    console.error(`[createPurchase] No se pudo sincronizar la compra ${purchase._id} a Sheets:`, err);
  });
  syncInventoryToSheets(product._id as Types.ObjectId).catch((err) => {
    console.error(`[createPurchase] No se pudo sincronizar inventario de ${product._id} a Sheets:`, err);
  });

  return res.status(201).json(purchase);
}

/**
 * GET /api/pos/purchases -> compras registradas por este cajero durante su
 * TURNO actual (ver `getCashierShiftStart` — mismo cambio que
 * `listCashierSales` en posController.ts, por la misma razón: un turno
 * puede cruzar medianoche, así que "hoy" cortaba mal esos casos).
 */
export async function listCashierPurchases(req: Request, res: Response) {
  const posSession = req.posSession!;
  const shiftStart = await getCashierShiftStart(posSession.branchId, posSession.cashierId);

  const purchases = await Purchase.find({
    branchId: posSession.branchId,
    registeredBy: posSession.cashierId,
    createdAt: { $gte: shiftStart },
  })
    .sort({ createdAt: -1 })
    .populate("productId", "name");

  return res.json(purchases);
}

/**
 * GET /api/pos/products -> catálogo de productos ACTIVOS para el selector
 * de la nueva compra del cajero, SIN filtrar por stock (a diferencia de
 * `getCatalog` en posController.ts) — el caso de uso típico es justamente
 * reabastecer un producto que está en 0. El cajero no puede crear
 * productos nuevos aquí (a diferencia de StockModal.tsx en el panel
 * admin) — solo elige entre los que ya existen.
 */
export async function listProductsForPurchase(req: Request, res: Response) {
  const products = await Product.find({ active: true })
    .select("name sku category price")
    .sort({ category: 1, name: 1 });
  return res.json(products);
}

/**
 * POST /api/admin/purchases -> el admin registra una compra de reabastecimiento
 * (elige producto, proveedor, monto total y cómo se reparte la cantidad entre
 * sedes). Crea un Purchase por sede (para que quede en el mismo listado que
 * las compras informales del cajero) y de una vez incrementa el stock — el
 * monto total se reparte proporcional a la cantidad de cada sede.
 */
export async function createPurchaseAdmin(req: Request, res: Response) {
  const { productId, supplierName, concept, amount, allocations } = req.body as {
    productId?: string;
    supplierName?: string;
    concept?: string;
    amount?: number;
    allocations?: { branchId: string; quantity: number }[];
  };

  if (!productId || !supplierName || !amount) {
    return res.status(400).json({ error: "Producto, proveedor y monto son requeridos" });
  }

  const valid = (allocations || []).filter((a) => a.branchId && a.quantity > 0);
  if (valid.length === 0) {
    return res.status(400).json({ error: "Asigna al menos una cantidad a una sede" });
  }

  // Un GERENTE solo puede comprar para su propia sede — a diferencia de
  // resolveBranchFilter (que reescribe el filtro de lectura en silencio),
  // acá se rechaza la escritura completa si intenta colar una sede ajena,
  // en vez de reescribirla, porque el admin-frontend ya solo le ofrece su
  // propia sede como opción (ver StockModal.tsx) — llegar aquí con otra
  // sede solo puede ser un cliente que se saltó esa restricción.
  if (req.admin?.role === "MANAGER") {
    const foreign = valid.some((a) => a.branchId !== req.admin!.branchId);
    if (foreign) {
      return res.status(403).json({ error: "Solo puedes registrar compras para tu propia sede" });
    }
  }

  const product = await Product.findById(productId);
  if (!product) return res.status(404).json({ error: "Producto no encontrado" });

  const totalQuantity = valid.reduce((sum, a) => sum + a.quantity, 0);
  const totalAmount = Number(amount);
  const purchaseConcept = concept || `Compra de stock: ${product.name}`;

  const purchases = [];
  let assignedAmount = 0;
  for (let i = 0; i < valid.length; i++) {
    const allocation = valid[i];
    const isLast = i === valid.length - 1;
    // La última sede se lleva el residuo del redondeo, así la suma de los
    // montos por sede siempre cuadra exacto con el monto total ingresado.
    const branchAmount = isLast
      ? totalAmount - assignedAmount
      : Math.round((allocation.quantity / totalQuantity) * totalAmount);
    assignedAmount += branchAmount;

    const purchase = await Purchase.create({
      branchId: allocation.branchId,
      registeredBy: req.admin!.userId,
      supplierName,
      concept: purchaseConcept,
      amount: branchAmount,
      paymentMethod: "OTHER",
      productId: product._id,
      quantity: allocation.quantity,
    });
    purchases.push(purchase);

    await ProductStock.findOneAndUpdate(
      { productId: product._id, branchId: allocation.branchId },
      { $inc: { quantity: allocation.quantity } },
      { upsert: true }
    );

    logPurchaseToSheets(purchase).catch((err) => {
      console.error(`[createPurchaseAdmin] No se pudo sincronizar la compra ${purchase._id} a Sheets:`, err);
    });
  }

  // Un solo llamado alcanza aunque la compra haya cubierto varias sedes —
  // syncInventoryToSheets recalcula el stock del producto en TODAS las
  // sedes de una vez, no hace falta uno por allocation.
  syncInventoryToSheets(product._id as Types.ObjectId).catch((err) => {
    console.error(`[createPurchaseAdmin] No se pudo sincronizar inventario de ${product._id} a Sheets:`, err);
  });

  return res.status(201).json(purchases);
}

/** GET /api/admin/purchases -> vista consolidada para el panel administrativo */
export async function listPurchasesAdmin(req: Request, res: Response) {
  const { from, to, productId, registeredBy } = req.query;
  const branchId = resolveBranchFilter(req);
  const filter: any = {};
  // `$match` en `Purchase.aggregate` (más abajo, para `totalAmount`) NO
  // castea tipos como sí lo hace `Model.find()`/`countDocuments()` —
  // comparar el string de `resolveBranchFilter`/query contra el ObjectId
  // real guardado en Mongo nunca matchea nada, así que `totalAmount` daba
  // 0 en cuanto se filtraba por sede/producto/usuario (bug real, mismo
  // gotcha ya documentado en `getDashboardMetrics`). Se castea a
  // `Types.ObjectId` acá, antes de usar `filter` en las tres consultas —
  // `find`/`countDocuments` aceptan un ObjectId real igual que un string,
  // así que no hace falta un filtro aparte solo para el aggregate.
  if (branchId) filter.branchId = new Types.ObjectId(branchId);
  if (productId) filter.productId = new Types.ObjectId(String(productId));
  if (registeredBy) filter.registeredBy = new Types.ObjectId(String(registeredBy));
  // `startOfLocalDay`/`endOfLocalDay` (ver punto 33/24 de CLAUDE.md) — antes
  // esto usaba `new Date(string)` a secas, que interpreta el string como
  // medianoche UTC, no Bogotá, mismo bug ya corregido en `listSales`.
  if (from || to) {
    filter.createdAt = {};
    if (from) filter.createdAt.$gte = startOfLocalDay(String(from));
    if (to) filter.createdAt.$lte = endOfLocalDay(String(to));
  }

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "20"), 10) || 20));

  const [purchases, total, totalAmountAgg] = await Promise.all([
    Purchase.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .populate("registeredBy", "name")
      .populate("branchId", "name")
      .populate("productId", "name"),
    Purchase.countDocuments(filter),
    // La UI muestra un total en dinero de TODAS las compras del filtro
    // (no solo la página actual), así que se agrega aparte de la
    // paginación en vez de sumarse en el cliente sobre `data`.
    Purchase.aggregate([{ $match: filter }, { $group: { _id: null, sum: { $sum: "$amount" } } }]),
  ]);
  const totalAmount = totalAmountAgg[0]?.sum || 0;

  return res.json({
    data: purchases,
    total,
    totalAmount,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  });
}

// Lookups livianos para los filtros "Producto"/"Usuario" de /compras — mismo
// patrón que `listSaleUsers` en adminController.ts: solo devuelven
// productos/usuarios que efectivamente tienen al menos una compra dentro
// del filtro de sede vigente, y solo filtran por sede (no por los demás
// filtros ya elegidos) porque son para poblar un <select>, no una tabla.
export async function listPurchaseProducts(req: Request, res: Response) {
  const branchId = resolveBranchFilter(req);
  const filter: any = {};
  if (branchId) filter.branchId = branchId;

  const productIds = await Purchase.distinct("productId", { ...filter, productId: { $ne: null } });
  const products = await Product.find({ _id: { $in: productIds } })
    .select("name")
    .sort({ name: 1 })
    .lean();

  return res.json(products);
}

export async function listPurchaseUsers(req: Request, res: Response) {
  const branchId = resolveBranchFilter(req);
  const filter: any = {};
  if (branchId) filter.branchId = branchId;

  const userIds = await Purchase.distinct("registeredBy", filter);
  const users = await User.find({ _id: { $in: userIds } })
    .select("name role")
    .sort({ name: 1 })
    .lean();

  return res.json(users);
}

/**
 * PUT /api/admin/purchases/:id — edita una compra ya registrada. Proveedor,
 * concepto y monto se pueden cambiar libremente (no afectan stock). La
 * cantidad SOLO aplica a compras de reabastecimiento (con `productId`, ver
 * `createPurchaseAdmin`) y cambiarla ajusta `ProductStock` por el delta:
 * subirla siempre es seguro (se suma), bajarla requiere que ese stock siga
 * disponible en la sede — si ya se vendió o se usó desde que se registró
 * la compra, se rechaza en vez de dejar el stock en negativo.
 */
export async function updatePurchaseAdmin(req: Request, res: Response) {
  const { supplierName, concept, amount, quantity } = req.body as {
    supplierName?: string;
    concept?: string;
    amount?: number;
    quantity?: number;
  };

  const purchase = await Purchase.findById(req.params.id);
  if (!purchase) return res.status(404).json({ error: "Compra no encontrada" });

  if (req.admin?.role === "MANAGER" && String(purchase.branchId) !== req.admin.branchId) {
    return res.status(403).json({ error: "No tienes acceso a esta compra" });
  }

  if (purchase.productId && quantity !== undefined) {
    const newQuantity = Number(quantity);
    if (!Number.isFinite(newQuantity) || newQuantity <= 0) {
      return res.status(400).json({ error: "La cantidad debe ser mayor a 0" });
    }
    const delta = newQuantity - (purchase.quantity || 0);
    if (delta > 0) {
      await ProductStock.findOneAndUpdate(
        { productId: purchase.productId, branchId: purchase.branchId },
        { $inc: { quantity: delta } },
        { upsert: true }
      );
    } else if (delta < 0) {
      // El `$gte` protege contra dejar el stock en negativo: si ya se
      // vendió/usó parte de lo que esta compra había agregado, no alcanza
      // para "quitarlo" ahora.
      const updated = await ProductStock.findOneAndUpdate(
        { productId: purchase.productId, branchId: purchase.branchId, quantity: { $gte: -delta } },
        { $inc: { quantity: delta } }
      );
      if (!updated) {
        return res.status(422).json({
          error: "STOCK_NO_DISPONIBLE",
          message:
            "No se puede reducir la cantidad: parte de ese stock ya fue vendido o usado.",
        });
      }
    }
    purchase.quantity = newQuantity;
    if (delta !== 0) {
      syncInventoryToSheets(purchase.productId).catch((err) => {
        console.error(`[updatePurchaseAdmin] No se pudo sincronizar inventario de ${purchase.productId} a Sheets:`, err);
      });
    }
  }

  if (supplierName !== undefined) purchase.supplierName = supplierName;
  if (concept !== undefined) purchase.concept = concept;
  if (amount !== undefined) purchase.amount = Number(amount);

  await purchase.save();
  await purchase.populate("registeredBy", "name");
  await purchase.populate("branchId", "name");
  await purchase.populate("productId", "name");

  return res.json(purchase);
}

/**
 * DELETE /api/admin/purchases/:id — borra una compra. Si era de
 * reabastecimiento (con `productId`/`quantity`), primero intenta revertir
 * el stock que había agregado — si ya no hay suficiente disponible en la
 * sede (se vendió o se usó desde entonces), rechaza el borrado en vez de
 * dejar stock negativo o borrar el registro sin revertir el inventario.
 */
export async function deletePurchaseAdmin(req: Request, res: Response) {
  const purchase = await Purchase.findById(req.params.id);
  if (!purchase) return res.status(404).json({ error: "Compra no encontrada" });

  if (req.admin?.role === "MANAGER" && String(purchase.branchId) !== req.admin.branchId) {
    return res.status(403).json({ error: "No tienes acceso a esta compra" });
  }

  if (purchase.productId && purchase.quantity) {
    const updated = await ProductStock.findOneAndUpdate(
      {
        productId: purchase.productId,
        branchId: purchase.branchId,
        quantity: { $gte: purchase.quantity },
      },
      { $inc: { quantity: -purchase.quantity } }
    );
    if (!updated) {
      return res.status(422).json({
        error: "STOCK_NO_DISPONIBLE",
        message: "No se puede eliminar: parte de ese stock ya fue vendido o usado.",
      });
    }
    syncInventoryToSheets(purchase.productId).catch((err) => {
      console.error(`[deletePurchaseAdmin] No se pudo sincronizar inventario de ${purchase.productId} a Sheets:`, err);
    });
  }

  await purchase.deleteOne();
  return res.status(204).send();
}
