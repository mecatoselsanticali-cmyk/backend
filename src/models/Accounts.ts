import { Schema, model, Document } from "mongoose";

/** Cuentas por Pagar (deudas con proveedores) */
export interface IAccountPayable extends Document {
  branchId: Schema.Types.ObjectId;
  supplierName: string;
  supplierNit?: string;
  invoiceNumber: string;
  totalAmount: number;
  paidAmount: number;
  dueDate: Date;
  status: "PENDING" | "PARTIAL" | "PAID" | "OVERDUE";
  notes?: string;
}

const AccountPayableSchema = new Schema<IAccountPayable>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    supplierName: { type: String, required: true },
    supplierNit: String,
    invoiceNumber: { type: String, required: true },
    totalAmount: { type: Number, required: true },
    paidAmount: { type: Number, default: 0 },
    dueDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["PENDING", "PARTIAL", "PAID", "OVERDUE"],
      default: "PENDING",
    },
    notes: String,
  },
  { timestamps: true }
);

export const AccountPayable = model<IAccountPayable>("AccountPayable", AccountPayableSchema);

/** Cuentas por Cobrar (créditos a clientes corporativos) */
export interface IAccountReceivable extends Document {
  branchId: Schema.Types.ObjectId;
  customerName: string;
  customerNit?: string;
  saleId?: Schema.Types.ObjectId;
  totalAmount: number;
  paidAmount: number;
  dueDate: Date;
  status: "PENDING" | "PARTIAL" | "PAID" | "OVERDUE";
  notes?: string;
}

const AccountReceivableSchema = new Schema<IAccountReceivable>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    customerName: { type: String, required: true },
    customerNit: String,
    saleId: { type: Schema.Types.ObjectId, ref: "Sale" },
    totalAmount: { type: Number, required: true },
    paidAmount: { type: Number, default: 0 },
    dueDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["PENDING", "PARTIAL", "PAID", "OVERDUE"],
      default: "PENDING",
    },
    notes: String,
  },
  { timestamps: true }
);

export const AccountReceivable = model<IAccountReceivable>(
  "AccountReceivable",
  AccountReceivableSchema
);
