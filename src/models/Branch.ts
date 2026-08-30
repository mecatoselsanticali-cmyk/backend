import { Schema, model, Document, Types } from "mongoose";

export interface IDianConfig {
  prefix: string;
  resolutionNumber: string;
  from: number;
  to: number;
  current: number;
  techKey: string;
}

export interface IBranch extends Document {
  name: string;
  address: string;
  phone: string;
  dianConfig: IDianConfig;
  dianResponsible: boolean; // Responsable de declarar ante la DIAN (dato informativo, no gatea la emisión — ver punto 10 de CLAUDE.md)
  status: boolean;
}

const DianConfigSchema = new Schema<IDianConfig>(
  {
    prefix: { type: String, default: "" },
    resolutionNumber: { type: String, default: "" },
    from: { type: Number, default: 0 },
    to: { type: Number, default: 0 },
    current: { type: Number, default: 0 },
    techKey: { type: String, default: "" },
  },
  { _id: false }
);

const BranchSchema = new Schema<IBranch>(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, required: true },
    phone: { type: String, required: true },
    dianConfig: { type: DianConfigSchema, default: () => ({}) },
    dianResponsible: { type: Boolean, default: true },
    status: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Branch = model<IBranch>("Branch", BranchSchema);
export type BranchId = Types.ObjectId;
