import { Schema, model, Document, Types } from "mongoose";

// Stock por sede de un producto. Vive en su propia colección (en vez de un
// campo embebido en Product) porque un mismo producto tiene una cantidad
// distinta en cada sede — ver comentario `branchStock` en Product.ts.
export interface IProductStock extends Document {
  productId: Types.ObjectId;
  branchId: Types.ObjectId;
  quantity: number;
}

const ProductStockSchema = new Schema<IProductStock>(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", required: true },
    quantity: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true }
);

ProductStockSchema.index({ productId: 1, branchId: 1 }, { unique: true });

export const ProductStock = model<IProductStock>("ProductStock", ProductStockSchema);
