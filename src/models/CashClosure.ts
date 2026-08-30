import { Schema, model, Document, Types } from "mongoose";

export type ClosureStatus = "OPEN" | "CLOSED";
export type ClosureReportType = "X" | "Z";

export interface IStockSnapshotItem {
  sku: string;
  name: string;
  price: number;
  quantity: number;
  totalValue: number;
}

// Verificación de stock física del cajero al abrir o cerrar turno — el
// `snapshot` lo arma el backend a partir de ProductStock/Product en el
// momento exacto de abrir/cerrar (nunca se confía en un snapshot mandado
// por el cliente), así que queda como un registro histórico de "qué stock
// había" en ese instante, no solo el resultado de la verificación.
export interface IStockVerification {
  confirmed: boolean;
  annotation?: string; // obligatorio del lado del backend si confirmed=false
  snapshot: IStockSnapshotItem[];
  verifiedAt: Date;
}

export interface ICashClosure extends Document {
  branchId: Types.ObjectId;
  cashierId: Types.ObjectId;
  openedAt: Date;
  closedAt?: Date;
  initialCash: number;
  initialNequi: number; // base de Nequi al abrir turno — igual que initialCash pero para el saldo digital
  declaredCash?: number; // arqueo ciego: lo que el cajero cuenta físicamente
  systemCalculatedCash?: number; // lo que el sistema espera según ventas en efectivo
  difference?: number; // declaredCash - systemCalculatedCash
  declaredNequi?: number; // saldo de Nequi que el cajero cuenta/verifica al cerrar
  systemCalculatedNequi?: number; // initialNequi + nequiTotal
  nequiDifference?: number; // declaredNequi - systemCalculatedNequi
  cardTotal: number;
  nequiTotal: number;
  appsTotal: number; // Rappi/DiDi
  pettyCashExpenses: number; // gastos menores de caja
  reportType?: ClosureReportType;
  status: ClosureStatus;
  openingStockVerification?: IStockVerification;
  closingStockVerification?: IStockVerification;
}

const StockSnapshotItemSchema = new Schema<IStockSnapshotItem>(
  {
    sku: String,
    name: String,
    price: Number,
    quantity: Number,
    totalValue: Number,
  },
  { _id: false }
);

const StockVerificationSchema = new Schema<IStockVerification>(
  {
    confirmed: { type: Boolean, required: true },
    annotation: { type: String },
    snapshot: { type: [StockSnapshotItemSchema], default: [] },
    verifiedAt: { type: Date, required: true },
  },
  { _id: false }
);

const CashClosureSchema = new Schema<ICashClosure>(
  {
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    cashierId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    openedAt: { type: Date, required: true },
    closedAt: { type: Date },
    initialCash: { type: Number, required: true, default: 0 },
    initialNequi: { type: Number, required: true, default: 0 },
    declaredCash: { type: Number },
    systemCalculatedCash: { type: Number },
    difference: { type: Number },
    declaredNequi: { type: Number },
    systemCalculatedNequi: { type: Number },
    nequiDifference: { type: Number },
    cardTotal: { type: Number, default: 0 },
    nequiTotal: { type: Number, default: 0 },
    appsTotal: { type: Number, default: 0 },
    pettyCashExpenses: { type: Number, default: 0 },
    reportType: { type: String, enum: ["X", "Z"] },
    status: { type: String, enum: ["OPEN", "CLOSED"], default: "OPEN" },
    openingStockVerification: { type: StockVerificationSchema },
    closingStockVerification: { type: StockVerificationSchema },
  },
  { timestamps: true }
);

export const CashClosure = model<ICashClosure>("CashClosure", CashClosureSchema);
