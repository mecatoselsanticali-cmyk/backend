import { Schema, model, Document } from "mongoose";

/**
 * Compra registrada por el cajero desde la pestaña "Compras" del POS —
 * distinta de `AccountPayable` (que es para facturas de proveedor a crédito
 * gestionadas por el admin). Esto es para compras informales del día a día
 * en la sede (ej. comprar insumos en el mercado), normalmente pagadas de
 * contado desde la caja.
 */
export interface IPurchase extends Document {
  branchId: Schema.Types.ObjectId;
  registeredBy: Schema.Types.ObjectId; // cajero (o admin) que la registró
  supplierName: string;
  concept: string;
  amount: number;
  paymentMethod: "CASH" | "OTHER";
  receiptImageUrl?: string;
  // Solo presentes cuando la compra se registra desde el admin como
  // reabastecimiento de inventario (ver createPurchaseAdmin) — el flujo del
  // cajero (createPurchase) nunca los envía.
  productId?: Schema.Types.ObjectId;
  quantity?: number;
  createdAt: Date;
}

const PurchaseSchema = new Schema<IPurchase>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true, index: true },
    registeredBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    supplierName: { type: String, required: true },
    concept: { type: String, required: true },
    amount: { type: Number, required: true },
    paymentMethod: { type: String, enum: ["CASH", "OTHER"], default: "CASH" },
    receiptImageUrl: String,
    productId: { type: Schema.Types.ObjectId, ref: "Product" },
    quantity: { type: Number },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const Purchase = model<IPurchase>("Purchase", PurchaseSchema);
