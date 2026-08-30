import { Schema, model, Document } from "mongoose";

export type ExpenseCategory =
  | "PETTY_CASH" // gasto menor de caja (registrado desde el POS)
  | "ARRIENDO"
  | "NOMINA"
  | "SERVICIOS_PUBLICOS"
  | "OTRO";

export interface IExpense extends Document {
  branchId: Schema.Types.ObjectId;
  registeredBy: Schema.Types.ObjectId;
  category: ExpenseCategory;
  concept: string;
  amount: number;
  cashClosureId?: Schema.Types.ObjectId; // si viene de caja menor, referencia al turno
  receiptUrl?: string;
}

const ExpenseSchema = new Schema<IExpense>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    registeredBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    category: {
      type: String,
      enum: ["PETTY_CASH", "ARRIENDO", "NOMINA", "SERVICIOS_PUBLICOS", "OTRO"],
      required: true,
    },
    concept: { type: String, required: true },
    amount: { type: Number, required: true },
    cashClosureId: { type: Schema.Types.ObjectId, ref: "CashClosure" },
    receiptUrl: String,
  },
  { timestamps: true }
);

export const Expense = model<IExpense>("Expense", ExpenseSchema);
