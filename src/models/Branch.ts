import { Schema, model, Document, Types } from "mongoose";

export interface IDianConfig {
  prefix: string;
  resolutionNumber: string;
  from: number;
  to: number;
  current: number;
  techKey: string;
  // Ids de la cuenta de Siigo (PTA) específicos de esta sede — NO son
  // globales: la cuenta de Siigo tiene un vendedor y un tipo de documento
  // (resolución de facturación electrónica) por punto de venta/sede
  // (confirmado consultando /v1/users y /v1/document-types reales — ver
  // `npm run test:siigo` en backend/CLAUDE.md). `undefined` mientras la
  // sede no se haya mapeado — `dianService.siigoEmit` rechaza con mensaje
  // claro si intenta emitir una venta de una sede sin estos dos ids.
  siigoSellerId?: number;
  siigoDocumentId?: number;
}

export interface IBranch extends Document {
  name: string;
  address: string;
  phone: string;
  // NIT de la razón social de esta sede. Varía por sede (cada sede puede
  // ser una razón social distinta o tener un NIT propio para facturación).
  // Se imprime en el recibo en pantalla y en el ticket térmico (antes era
  // una constante hardcodeada en 3 archivos, ahora es un dato de la sede).
  // `default: ""` para que los documentos existentes sin este campo (mongo
  // los rellena al hacer find) impriman la línea vacía en vez de un NIT
  // falso — el admin edita la sede y lo llena.
  nit: string;
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
    siigoSellerId: { type: Number },
    siigoDocumentId: { type: Number },
  },
  { _id: false }
);

const BranchSchema = new Schema<IBranch>(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, required: true },
    phone: { type: String, required: true },
    nit: { type: String, default: "", trim: true, maxlength: 30 },
    dianConfig: { type: DianConfigSchema, default: () => ({}) },
    dianResponsible: { type: Boolean, default: true },
    status: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Branch = model<IBranch>("Branch", BranchSchema);
export type BranchId = Types.ObjectId;
