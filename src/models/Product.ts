import { Schema, model, Document, Types } from "mongoose";

export interface IModifier {
  name: string;
  extraPrice: number;
}

export interface IRecipeItem {
  supplyId: Types.ObjectId;
  quantity: number;
  unit: string;
}

export interface IProduct extends Document {
  name: string;
  sku: string;
  category: string;
  price: number;
  imageUrl?: string;
  modifiers: IModifier[];
  recipe: IRecipeItem[];
  active: boolean;
  branchStock?: number; // opcional si se maneja stock por sede en otra colección
}

const ModifierSchema = new Schema<IModifier>(
  { name: String, extraPrice: { type: Number, default: 0 } },
  { _id: false }
);

const RecipeItemSchema = new Schema<IRecipeItem>(
  {
    supplyId: { type: Schema.Types.ObjectId, ref: "Supply" },
    quantity: Number,
    unit: String,
  },
  { _id: false }
);

const ProductSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, unique: true },
    category: { type: String, required: true, index: true },
    price: { type: Number, required: true },
    imageUrl: { type: String },
    modifiers: { type: [ModifierSchema], default: [] },
    recipe: { type: [RecipeItemSchema], default: [] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

ProductSchema.index({ name: "text", sku: "text" });

export const Product = model<IProduct>("Product", ProductSchema);
