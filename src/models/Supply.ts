import { Schema, model, Document } from "mongoose";

export interface ISupply extends Document {
  name: string;
  unit: string; // kg, g, l, ml, unidad
  stock: number;
  minStock: number;
  costPerUnit: number;
  branchId: Schema.Types.ObjectId;
}

const SupplySchema = new Schema<ISupply>(
  {
    name: { type: String, required: true },
    unit: { type: String, required: true },
    stock: { type: Number, default: 0 },
    minStock: { type: Number, default: 0 },
    costPerUnit: { type: Number, default: 0 },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
  },
  { timestamps: true }
);

export const Supply = model<ISupply>("Supply", SupplySchema);

export type MovementType = "IN" | "OUT" | "TRANSFER" | "MERMA";

export interface IStockMovement extends Document {
  supplyId: Schema.Types.ObjectId;
  branchId: Schema.Types.ObjectId;
  type: MovementType;
  quantity: number;
  reason: string;
  relatedSaleId?: Schema.Types.ObjectId;
  targetBranchId?: Schema.Types.ObjectId; // para traslados entre sedes
}

const StockMovementSchema = new Schema<IStockMovement>(
  {
    supplyId: { type: Schema.Types.ObjectId, ref: "Supply", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    type: { type: String, enum: ["IN", "OUT", "TRANSFER", "MERMA"], required: true },
    quantity: { type: Number, required: true },
    reason: { type: String, default: "" },
    relatedSaleId: { type: Schema.Types.ObjectId, ref: "Sale" },
    targetBranchId: { type: Schema.Types.ObjectId, ref: "Branch" },
  },
  { timestamps: true }
);

export const StockMovement = model<IStockMovement>("StockMovement", StockMovementSchema);
