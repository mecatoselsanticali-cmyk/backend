import { Schema, model, Document, Types } from "mongoose";

// Merma de stock sin venta detrás (producto dañado/vencido, consumo interno
// de un empleado, etc.) — registrada desde el POS del cajero, ver punto 45
// de admin-frontend/src/cajero/CLAUDE.md. Reduce ProductStock igual que una
// venta, pero no crea ningún Sale ni mueve dinero.
export type StockLossReason = "DAMAGED" | "STAFF_CONSUMPTION" | "OTHER";

export interface IStockLoss extends Document {
  branchId: Types.ObjectId;
  productId: Types.ObjectId;
  registeredBy: Types.ObjectId;
  quantity: number;
  reason: StockLossReason;
  note?: string;
}

const StockLossSchema = new Schema<IStockLoss>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    registeredBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    quantity: { type: Number, required: true, min: 1 },
    reason: {
      type: String,
      enum: ["DAMAGED", "STAFF_CONSUMPTION", "OTHER"],
      required: true,
    },
    note: String,
  },
  { timestamps: true }
);

export const StockLoss = model<IStockLoss>("StockLoss", StockLossSchema);
