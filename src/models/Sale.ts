import { Schema, model, Document, Types } from "mongoose";

export type OrderType = "POS_COUNTER" | "RAPPI" | "DIDI" | "DELIVERY_LOCAL";
// CASH/CARD/DELIVERY_APP son valores históricos, reemplazados por
// EFECTIVO/BANCOLOMBIA (NEQUI no cambió) — se mantienen en el tipo/enum
// solo para que ventas viejas sigan leyéndose bien, nunca se ofrecen en
// ningún formulario nuevo (mismo tratamiento que ya tenía CARD, ver punto
// 61 de admin-frontend/CLAUDE.md). Ver PAYMENT_METHOD_GROUP más abajo y el
// punto 34 de CLAUDE.md (reescrito) para el detalle completo.
export type PaymentMethod = "CASH" | "NEQUI" | "CARD" | "DELIVERY_APP" | "EFECTIVO" | "BANCOLOMBIA";

// Agrupa valores viejos y nuevos que representan el mismo destino real del
// dinero — único punto de verdad para todo lo que suma/filtra por método de
// pago (arqueo de caja, dashboard, reportes, filtro de listSales), así no
// hay que repetir la lista vieja+nueva en cada lugar. Ver punto 34 de
// CLAUDE.md.
export type PaymentMethodGroup = "CASH_GROUP" | "NEQUI_GROUP" | "CARD_GROUP" | "BANCOLOMBIA_GROUP";
export const PAYMENT_METHOD_GROUP: Record<PaymentMethod, PaymentMethodGroup> = {
  CASH: "CASH_GROUP",
  EFECTIVO: "CASH_GROUP",
  NEQUI: "NEQUI_GROUP",
  CARD: "CARD_GROUP",
  DELIVERY_APP: "BANCOLOMBIA_GROUP",
  BANCOLOMBIA: "BANCOLOMBIA_GROUP",
};
export type PaymentStatus = "COMPLETED" | "PENDING_PAYMENT";
export type DianStatus = "PENDING" | "SENT" | "APPROVED" | "REJECTED";
export type InvoiceType = "POS_DOC" | "FACTURA_NOMINAL";
export type SaleStatus = "ACTIVE" | "CANCELLED";
// Etiqueta manual, elegida por quien registra la venta (no calculada a
// partir del monto ni de otras ventas) — ver punto 20 de CLAUDE.md.
export type SaleCategory = "REGULAR" | "SPECIAL";

export interface ISaleItem {
  productId: Types.ObjectId;
  name: string;
  quantity: number;
  price: number;
  modifiers?: { name: string; extraPrice: number }[];
  subtotal: number;
}

export interface ISaleCustomer {
  name?: string;
  document?: string;
  email?: string;
}

export interface ISale extends Document {
  branchId: Types.ObjectId;
  cashierId: Types.ObjectId;
  orderType: OrderType;
  items: ISaleItem[];
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  settlementDate?: Date; // se llena al confirmar el pago (ver confirmSalePayment)
  // Número de comprobante/transferencia que el admin escribe al confirmar el
  // pago (individual o en bloque, ver confirmSalePayment/confirmSalePaymentBulk
  // en adminController.ts) — puramente informativo, de referencia para
  // conciliar contra el extracto bancario. Opcional: confirmar un pago nunca
  // exigió este dato antes de que existiera la confirmación en bloque, y
  // seguir sin exigirlo evita romper el flujo de confirmar una sola venta.
  settlementReference?: string;
  subtotal: number;
  // El negocio no es responsable de declarar/cobrar impuestos (IVA/INC) —
  // decisión explícita, los 3 sitios que crean una venta (posController.
  // createSale/syncOfflineSales, adminController.createSaleAdmin) ya
  // dejan este campo fijo en 0 en vez de calcular el 8% placeholder que
  // existía antes. Se mantiene en el schema (no se borra) solo por
  // compatibilidad de lectura con ventas históricas que sí tienen un
  // valor real acá — no se muestra en ningún recibo/reporte nuevo (ver
  // punto 65 de admin-frontend/CLAUDE.md).
  tax: number;
  total: number;
  customer?: ISaleCustomer;
  invoiceType: InvoiceType;
  dianStatus: DianStatus;
  cufe?: string;
  qrCodeUrl?: string;
  // Número real de la factura electrónica asignado por el PTA (ej.
  // "FV-3-7" en Siigo, campo `name` de su respuesta) — se usa en el
  // recibo ("Factura electrónica de venta No. ...") cuando la venta ya
  // está timbrada. Ver dianService.ts/dianWorker.ts.
  dianInvoiceNumber?: string;
  offlineCreated: boolean;
  localTicketId?: string; // id generado en el cliente offline (Dexie) para deduplicar en sync
  status: SaleStatus;
  category: SaleCategory;
  // true solo si esta venta descontó ProductStock al crearse (hoy, solo
  // POST /api/admin/sales lo hace — ver punto 19 de CLAUDE.md). Se usa al
  // cancelar para saber si hay que restaurar stock o no.
  stockDecremented: boolean;
  createdAt: Date;
}

const SaleItemSchema = new Schema<ISaleItem>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    name: String,
    quantity: Number,
    price: Number,
    modifiers: [{ name: String, extraPrice: Number }],
    subtotal: Number,
  },
  { _id: false }
);

const SaleSchema = new Schema<ISale>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    cashierId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    orderType: {
      type: String,
      enum: ["POS_COUNTER", "RAPPI", "DIDI", "DELIVERY_LOCAL"],
      default: "POS_COUNTER",
    },
    items: { type: [SaleItemSchema], required: true },
    paymentMethod: {
      type: String,
      enum: ["CASH", "NEQUI", "CARD", "DELIVERY_APP", "EFECTIVO", "BANCOLOMBIA"],
      required: true,
    },
    // Default "COMPLETED" en el schema por si algo crea un Sale sin pasar
    // por `resolvePaymentStatus` (ej. un script/seed) — en el flujo normal,
    // los 3 puntos que llaman `Sale.create` (posController.createSale,
    // posController.syncOfflineSales, adminController.createSaleAdmin) SÍ
    // calculan este valor explícitamente a partir de `paymentMethod`.
    paymentStatus: {
      type: String,
      enum: ["COMPLETED", "PENDING_PAYMENT"],
      default: "COMPLETED",
      index: true,
    },
    settlementDate: Date,
    settlementReference: String,
    subtotal: { type: Number, required: true },
    tax: { type: Number, required: true },
    total: { type: Number, required: true },
    customer: {
      name: String,
      document: String,
      email: String,
    },
    invoiceType: {
      type: String,
      enum: ["POS_DOC", "FACTURA_NOMINAL"],
      default: "POS_DOC",
    },
    dianStatus: {
      type: String,
      enum: ["PENDING", "SENT", "APPROVED", "REJECTED"],
      default: "PENDING",
      index: true,
    },
    cufe: String,
    qrCodeUrl: String,
    dianInvoiceNumber: String,
    offlineCreated: { type: Boolean, default: false },
    localTicketId: { type: String, index: true, sparse: true, unique: true },
    status: { type: String, enum: ["ACTIVE", "CANCELLED"], default: "ACTIVE", index: true },
    category: { type: String, enum: ["REGULAR", "SPECIAL"], default: "REGULAR", index: true },
    stockDecremented: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: true } }
);

SaleSchema.index({ branchId: 1, createdAt: -1 });

export const Sale = model<ISale>("Sale", SaleSchema);

/**
 * true si el canal de la venta es un agregador de domicilios (Rappi o
 * DiDi) — el único disparador de la Cuenta por Cobrar Bancolombia desde
 * este refactor (ver punto 34 de CLAUDE.md, reescrito). A propósito ya NO
 * depende de `paymentMethod`: antes se evitaba a propósito gatear por
 * `orderType` porque un domicilio DiDi pagado en efectivo contra entrega
 * no debía quedar pendiente — se decidió explícitamente revertir eso, así
 * que ahora CUALQUIER venta con canal Rappi/DiDi quiere Bancolombia +
 * pendiente, sin importar cómo se cobró en la calle.
 */
export function isDeliveryAppChannel(orderType: OrderType): boolean {
  return orderType === "RAPPI" || orderType === "DIDI";
}

/**
 * Fuerza `paymentMethod: "BANCOLOMBIA"` cuando el canal es Rappi/DiDi,
 * ignorando lo que se haya pedido — para cualquier otro canal respeta el
 * método pedido tal cual. Server-side siempre, no confíes en que el
 * cliente ya lo mandó forzado (mismo criterio que el resto del proyecto:
 * el backend es quien valida reglas de negocio, no el frontend).
 */
export function resolvePaymentMethodForChannel(
  orderType: OrderType,
  requestedPaymentMethod: PaymentMethod
): PaymentMethod {
  return isDeliveryAppChannel(orderType) ? "BANCOLOMBIA" : requestedPaymentMethod;
}

/**
 * Único punto de verdad para el `paymentStatus` de una venta — usado por
 * los 3 sitios que llaman `Sale.create` (posController.createSale,
 * posController.syncOfflineSales, adminController.createSaleAdmin) y por
 * `updateSaleAdmin` al recalcular tras un cambio de canal/método. Ver
 * punto 34 de CLAUDE.md. Firma cambiada: antes tomaba `paymentMethod`
 * (comparaba contra `"DELIVERY_APP"`), ahora toma `orderType` — ver
 * `isDeliveryAppChannel` arriba para el porqué del cambio.
 */
export function resolvePaymentStatus(orderType: OrderType): PaymentStatus {
  return isDeliveryAppChannel(orderType) ? "PENDING_PAYMENT" : "COMPLETED";
}
