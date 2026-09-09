import { Request, Response } from "express";
import { Product } from "../models/Product";
import { ProductStock } from "../models/ProductStock";
import { Sale, resolvePaymentStatus } from "../models/Sale";
import { Branch } from "../models/Branch";
import { Expense } from "../models/Expense";
import { StockLoss } from "../models/StockLoss";
import { dianService } from "../services/dianService";
import { enqueueSaleForDianEmission } from "../queues/dianQueue";
import { logSaleToSheets, logExpenseToSheets, logStockLossToSheets, syncInventoryToSheets } from "../utils/sheetsSync";
import { getCashierShiftStart } from "../utils/shiftRange";
import { getStartOfTodayColombia } from "../utils/dateRange";
import { Types } from "mongoose";

/**
 * GET /api/pos/catalog -> productos activos CON stock disponible en la
 * sede del cajero. Antes devolvía todo `active: true` sin mirar
 * ProductStock — un cajero podía intentar vender algo con 0 unidades en su
 * sede. El grid ya no debe ofrecer eso como opción.
 *
 * Pagina desde el backend (`page`/`pageSize`, mismo shape `{ data, total,
 * page, pageSize, totalPages }` que el resto de endpoints `list*`, ver
 * punto 15 de CLAUDE.md) y acepta `search` (nombre o SKU) y `category` —
 * antes devolvía el catálogo completo de la sede de una sola vez y
 * `CategoryMenu.tsx` filtraba/paginaba todo en el cliente, lo cual dejaba
 * de tener sentido en cuanto el catálogo de una sede crece lo suficiente
 * para no caber cómodo en una sola pantalla táctil.
 *
 * `categories` en la respuesta es la lista de categorías distintas del
 * catálogo COMPLETO en stock de la sede (sin aplicar `search`/`category`,
 * calculada sobre `baseFilter`) — así las pestañas de categoría del
 * frontend no aparecen/desaparecen mientras el cajero busca o pagina.
 */
export async function getCatalog(req: Request, res: Response) {
  const posSession = req.posSession!;
  const { search, category } = req.query;

  const stocks = await ProductStock.find({
    branchId: posSession.branchId,
    quantity: { $gt: 0 },
  }).select("productId");
  const inStockIds = stocks.map((s) => s.productId);

  const baseFilter: any = { active: true, _id: { $in: inStockIds } };
  const categories = await Product.distinct("category", baseFilter);

  const filter: any = { ...baseFilter };
  if (category) filter.category = String(category);
  if (search) {
    const term = String(search).trim();
    if (term) {
      // Mismo patrón de regex escapado + case-insensitive que
      // listBranches/listUsers (ver punto 15/18 de backend/CLAUDE.md) — el
      // catálogo de una sede no justifica un índice $text aparte.
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { name: { $regex: escaped, $options: "i" } },
        { sku: { $regex: escaped, $options: "i" } },
      ];
    }
  }

  const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize ?? "24"), 10) || 24));

  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort({ category: 1, name: 1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
    Product.countDocuments(filter),
  ]);

  return res.json({
    data: products,
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    categories: categories.sort(),
  });
}

/**
 * POST /api/pos/sales
 * Crea una venta EN LÍNEA (ver punto 8 de CLAUDE.md — el fallback a cola
 * offline en Dexie ya no se usa desde el frontend para ventas nuevas; este
 * endpoint sigue aceptando `offlineCreated`/`localTicketId` únicamente
 * para no romper cualquier tiquete que haya quedado pendiente de una
 * sesión anterior y `syncOfflineSales` termine de drenar).
 *
 * A partir de ahora SÍ valida y descuenta `ProductStock`, igual que
 * `createSaleAdmin` — si no hay stock suficiente en la sede del cajero,
 * la venta se rechaza (422) en vez de completarse.
 *
 * REQ-01/02/10: cero intervención del cajero en el CUFE, emisión asíncrona,
 * y exigencia de datos del comprador si supera el tope DIAN.
 */
export async function createSale(req: Request, res: Response) {
  const posSession = req.posSession!;
  const {
    items,
    paymentMethod,
    customer,
    orderType,
    offlineCreated,
    localTicketId,
  } = req.body;
  const THIRTY_MINUTES = 2 * 60 * 1000;
  const MAX_GROUP_1 = 509000;
  let category: string = "REGULAR";
  let hasSpace: boolean = false;
  let thirtyMinutesPassed: boolean = false;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "La venta debe tener al menos un ítem" });
  }

  // Idempotencia: si ya se sincronizó este tiquete offline, no duplicar
  if (localTicketId) {
    const existing = await Sale.findOne({ localTicketId });
    if (existing) {
      await existing.populate("branchId", "name address phone");
      await existing.populate("cashierId", "name");
      return res.status(200).json(existing);
    }
  }

  // Misma validación de stock que createSaleAdmin (ver adminController.ts):
  // se revisa ANTES de crear la venta, para poder rechazarla sin dejar
  // ningún rastro si algún ítem no alcanza.
  const productIds = items.map((it: any) => it.productId);
  const stocks = await ProductStock.find({
    productId: { $in: productIds },
    branchId: posSession.branchId,
  }).lean();
  const stockByProduct = new Map(stocks.map((s) => [String(s.productId), s.quantity]));

  const insufficient: string[] = [];
  for (const it of items as any[]) {
    const quantity = Number(it.quantity) || 0;
    const available = stockByProduct.get(String(it.productId)) || 0;
    if (quantity <= 0 || quantity > available) {
      insufficient.push(`${it.name || it.productId} (disponible: ${available})`);
    }
  }
  if (insufficient.length > 0) {
    return res.status(422).json({
      error: "STOCK_INSUFICIENTE",
      message: `No hay stock suficiente para: ${insufficient.join(", ")}`,
    });
  }

  const subtotal = items.reduce((acc: number, it: any) => acc + it.subtotal, 0);
  // El negocio no es responsable de declarar/cobrar impuestos (IVA/INC) —
  // decisión explícita, `tax` se deja fijo en 0 en vez de calcular el 8%
  // placeholder que existía antes. El campo se mantiene en `Sale` (no se
  // borra del schema) solo por compatibilidad de lectura con ventas
  // históricas que sí tienen un valor real ahí.
  const tax = 0;
  const total = subtotal;

  //const requiresNominal = dianService.requiresNominalInvoice(total);

  /** 
  if (requiresNominal && (!customer || !customer.document)) {
    return res.status(422).json({
      error: "REQUIERE_DATOS_CLIENTE",
      message:
        "La venta supera el tope de consumidor final. Se requieren datos del comprador para Factura Electrónica Nominal.",
    });
  }
    */

  const branchInfo = await Branch.findById(posSession.branchId);
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
      branchId: posSession.branchId,
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
          branchId: new Types.ObjectId(posSession.branchId),
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

  // Factura Electrónica Nominal también aplica cuando el CLIENTE la pide
  // voluntariamente (aunque la venta no supere el tope) — el cajero le
  // pregunta antes de cobrar (InvoicePromptModal.tsx) y, si acepta, captura
  // sus datos con el mismo CustomerModal que ya exige el tope. `customer`
  // solo llega poblado en ese caso (o en el caso obligatorio de arriba), así
  // que su sola presencia con `document` ya es señal suficiente — no hace
  // falta un flag aparte en el payload.
  const wantsNominalInvoice = Boolean(customer?.document);

  // Crea la venta ANTES de descontar stock (mismo razonamiento que
  // createSaleAdmin): si el descuento fallara a mitad de camino, es
  // preferible tener el registro de venta para reconciliar a mano que
  // perder stock sin ninguna venta que lo explique.
  const sale = await Sale.create({
    branchId: posSession.branchId,
    cashierId: posSession.cashierId,
    orderType: orderType || "POS_COUNTER",
    items,
    paymentMethod,
    paymentStatus: resolvePaymentStatus(paymentMethod),
    subtotal,
    tax,
    total,
    customer,
    invoiceType: wantsNominalInvoice ? "FACTURA_NOMINAL" : "POS_DOC",
    dianStatus: "PENDING",
    offlineCreated: Boolean(offlineCreated),
    localTicketId,
    stockDecremented: true,
    category,
  });

  // `$gte` como segunda defensa ante una venta concurrente (otra caja, o
  // el admin) que haya vaciado el stock justo entre la validación y acá.
  for (const it of items as any[]) {
    await ProductStock.findOneAndUpdate(
      { productId: it.productId, branchId: posSession.branchId, quantity: { $gte: it.quantity } },
      { $inc: { quantity: -it.quantity } }
    );
  }

  // Emisión 100% en segundo plano (REQ-02).
  // Se envuelve en try/catch: si Redis falla al encolar, la venta ya quedó
  // guardada en Mongo y de todas formas respondemos al cajero. La venta
  // simplemente queda dianStatus=PENDING hasta que se reintente el encolado
  // (ver nota más abajo sobre reconciliación).
  if(branchInfo.dianResponsible === true && hasSpace && thirtyMinutesPassed){
    try {
      await enqueueSaleForDianEmission(String(sale._id));
    } catch (err) {
      console.error(`[createSale] No se pudo encolar la venta ${sale._id} para DIAN:`, err);
    }
  }

  logSaleToSheets(sale).catch((err) => {
    console.error(`[createSale] No se pudo sincronizar la venta ${sale._id} a Sheets:`, err);
  });
  for (const it of items as any[]) {
    syncInventoryToSheets(it.productId).catch((err) => {
      console.error(`[createSale] No se pudo sincronizar inventario de ${it.productId} a Sheets:`, err);
    });
  }

  // Poblado antes de responder para que el recibo imprimible del cajero
  // (cajero/components/SaleReceipt.tsx) pueda renderizarse directo con esta
  // respuesta, sin una segunda llamada — mismo principio que
  // createSaleAdmin/listCashierSales.
  await sale.populate("branchId", "name address phone");
  await sale.populate("cashierId", "name");

  return res.status(201).json(sale);
}

/**
 * POST /api/pos/sales/sync-batch
 * Recibe un lote de ventas encoladas en IndexedDB mientras el POS estuvo offline.
 */
export async function syncOfflineSales(req: Request, res: Response) {
  const posSession = req.posSession!;
  const { sales } = req.body as { sales: any[] };

  if (!Array.isArray(sales)) {
    return res.status(400).json({ error: "Formato de lote inválido" });
  }

  const results = [];

  for (const raw of sales) {
    try {
      if (raw.localTicketId) {
        const existing = await Sale.findOne({ localTicketId: raw.localTicketId });
        if (existing) {
          results.push({ localTicketId: raw.localTicketId, status: "ALREADY_SYNCED", saleId: existing._id });
          continue;
        }
      }

      const subtotal = raw.items.reduce((acc: number, it: any) => acc + it.subtotal, 0);
      // Sin impuestos (ver el mismo criterio en createSale, arriba en este
      // archivo) — esto también corrige una inconsistencia real que ya
      // existía acá: este drenaje legado sumaba `tax` a `total`
      // (`subtotal + tax`), a diferencia de `createSale`/`createSaleAdmin`,
      // que siempre dejaron `total = subtotal` sin sumar el impuesto. Con
      // `tax` en 0 la diferencia deja de importar en la práctica.
      const tax = 0;
      const total = subtotal;
      const requiresNominal = dianService.requiresNominalInvoice(total);

      const sale = await Sale.create({
        branchId: posSession.branchId,
        cashierId: posSession.cashierId,
        orderType: raw.orderType || "POS_COUNTER",
        items: raw.items,
        paymentMethod: raw.paymentMethod,
        paymentStatus: resolvePaymentStatus(raw.paymentMethod),
        subtotal,
        tax,
        total,
        customer: raw.customer,
        invoiceType: requiresNominal ? "FACTURA_NOMINAL" : "POS_DOC",
        dianStatus: "PENDING",
        offlineCreated: true,
        localTicketId: raw.localTicketId,
      });

      try {
        await enqueueSaleForDianEmission(String(sale._id));
      } catch (err) {
        console.error(`[syncOfflineSales] No se pudo encolar la venta ${sale._id} para DIAN:`, err);
      }

      logSaleToSheets(sale).catch((err) => {
        console.error(`[syncOfflineSales] No se pudo sincronizar la venta ${sale._id} a Sheets:`, err);
      });

      results.push({ localTicketId: raw.localTicketId, status: "SYNCED", saleId: sale._id });
    } catch (err: any) {
      results.push({ localTicketId: raw.localTicketId, status: "ERROR", message: err.message });
    }
  }

  return res.json({ results });
}

/** GET /api/pos/sales/daily-total -> acumulado diario para el control de tope por sede (REQ-03/04) */
export async function getDailyTotal(req: Request, res: Response) {
  const posSession = req.posSession!;
  const startOfDay = getStartOfTodayColombia();

  const [branch, result] = await Promise.all([
    Branch.findById(posSession.branchId),
    Sale.aggregate([
      { $match: { branchId: posSession.branchId, createdAt: { $gte: startOfDay } } },
      { $group: { _id: null, total: { $sum: "$total" } } },
    ]),
  ]);

  const totalToday = result[0]?.total || 0;

  return res.json({
    totalToday,
  });
}

/**
 * GET /api/pos/sales/history
 * Facturas creadas por este cajero durante su TURNO actual (desde que abrió
 * el último `CashClosure`, sin importar si ya lo cerró — ver
 * `getCashierShiftStart` — no por día calendario ni por login: un turno
 * puede cruzar medianoche, y cerrar sesión/volver a entrar mientras el
 * turno sigue abierto no debe "perder" nada) en su sede, con su estado de
 * emisión DIAN (CUFE/QR una vez aprobadas).
 *
 * Incluye items/subtotal/tax/customer/branchId/cashierId (poblados) para que
 * el recibo imprimible de Facturas.tsx (cajero/components/SaleReceipt.tsx)
 * pueda renderizarse directo desde esta lista, sin una segunda llamada —
 * mismo principio que listSales/createSaleAdmin en el panel admin.
 */
export async function listCashierSales(req: Request, res: Response) {
  const posSession = req.posSession!;
  const shiftStart = await getCashierShiftStart(posSession.branchId, posSession.cashierId);

  const sales = await Sale.find({
    branchId: posSession.branchId,
    cashierId: posSession.cashierId,
    createdAt: { $gte: shiftStart },
  })
    .sort({ createdAt: -1 })
    .limit(200)
    .select(
      "total paymentMethod dianStatus cufe qrCodeUrl createdAt invoiceType orderType items subtotal tax customer status category branchId cashierId"
    )
    .populate("branchId", "name address phone")
    .populate("cashierId", "name");

  return res.json(sales);
}

/** POST /api/pos/expenses -> registrar gasto menor de caja (modal flotante) */
export async function registerPettyCashExpense(req: Request, res: Response) {
  const posSession = req.posSession!;
  const { concept, amount } = req.body;

  if (!concept || !amount) {
    return res.status(400).json({ error: "Concepto y monto son requeridos" });
  }

  const expense = await Expense.create({
    branchId: posSession.branchId,
    registeredBy: posSession.cashierId,
    category: "PETTY_CASH",
    concept,
    amount,
  });

  logExpenseToSheets(expense).catch((err) => {
    console.error(`[registerPettyCashExpense] No se pudo sincronizar el gasto ${expense._id} a Sheets:`, err);
  });

  return res.status(201).json(expense);
}

const STOCK_LOSS_REASONS = ["DAMAGED", "STAFF_CONSUMPTION", "OTHER"];

/**
 * POST /api/pos/stock-losses -> registrar una merma (producto dañado/
 * vencido, consumo interno de un empleado, etc.) — reduce ProductStock sin
 * que exista una venta ni ningún movimiento de dinero detrás. Mismo
 * `$gte` de defensa contra concurrencia que `createSale`/
 * `deletePurchaseAdmin`, pero acá se aplica ANTES de crear el registro (a
 * diferencia de `createSale`, que crea la venta primero): una merma sin
 * stock real que la respalde no tiene ningún valor que preservar para
 * reconciliar a mano, así que no tiene sentido dejar un `StockLoss`
 * huérfano si el descuento falla.
 */
export async function registerStockLoss(req: Request, res: Response) {
  const posSession = req.posSession!;
  const { productId, quantity, reason, note } = req.body;

  if (!productId || !quantity || !reason) {
    return res.status(400).json({ error: "Producto, cantidad y motivo son requeridos" });
  }
  const parsedQuantity = Number(quantity);
  if (!(parsedQuantity > 0)) {
    return res.status(400).json({ error: "La cantidad debe ser mayor a 0" });
  }
  if (!STOCK_LOSS_REASONS.includes(reason)) {
    return res.status(400).json({ error: "Motivo inválido" });
  }

  const product = await Product.findById(productId);
  if (!product) return res.status(404).json({ error: "Producto no encontrado" });

  const updated = await ProductStock.findOneAndUpdate(
    { productId: product._id, branchId: posSession.branchId, quantity: { $gte: parsedQuantity } },
    { $inc: { quantity: -parsedQuantity } }
  );
  if (!updated) {
    return res.status(422).json({
      error: "STOCK_INSUFICIENTE",
      message: `No hay stock suficiente de ${product.name} para registrar esta merma`,
    });
  }

  const stockLoss = await StockLoss.create({
    branchId: posSession.branchId,
    productId: product._id,
    registeredBy: posSession.cashierId,
    quantity: parsedQuantity,
    reason,
    note: note || undefined,
  });

  logStockLossToSheets(stockLoss).catch((err) => {
    console.error(`[registerStockLoss] No se pudo sincronizar la merma ${stockLoss._id} a Sheets:`, err);
  });
  syncInventoryToSheets(product._id as Types.ObjectId).catch((err) => {
    console.error(`[registerStockLoss] No se pudo sincronizar inventario de ${product._id} a Sheets:`, err);
  });

  return res.status(201).json(stockLoss);
}
