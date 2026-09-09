import { Schema, model, Document, Types } from "mongoose";

export type OrderType = "POS_COUNTER" | "RAPPI" | "DIDI" | "DELIVERY_LOCAL";
export type PaymentMethod = "CASH" | "NEQUI" | "CARD" | "DELIVERY_APP";
// CASH/NEQUI/CARD se dan por cobrados el mismo día; DELIVERY_APP (Rappi/
// DiDi) lo cobra el agregador y liquida el dinero a la cuenta bancaria días
// después — hasta entonces es Cuentas por Cobrar, no caja. Ver punto 34 de
// CLAUDE.md.
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
      enum: ["CASH", "NEQUI", "CARD", "DELIVERY_APP"],
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
 * Único punto de verdad para el `paymentStatus` inicial de una venta nueva
 * — usado por los 3 sitios que llaman `Sale.create` (posController.createSale,
 * posController.syncOfflineSales, adminController.createSaleAdmin) y por
 * `updateSaleAdmin` al recalcular tras un cambio de `paymentMethod`. Ver
 * punto 34 de CLAUDE.md.
 */
export function resolvePaymentStatus(paymentMethod: PaymentMethod): PaymentStatus {
  return paymentMethod === "DELIVERY_APP" ? "PENDING_PAYMENT" : "COMPLETED";
}
