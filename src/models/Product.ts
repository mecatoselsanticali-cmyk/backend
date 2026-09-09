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
  // Umbral de stock mínimo para la alerta de "Stock Crítico" del Dashboard
  // (ver punto 62 de admin-frontend/CLAUDE.md) — `0` (default) significa
  // "sin monitorear": el producto nunca aparece en la alerta hasta que un
  // admin le asigna un umbral explícito arriba de 0. Es un solo número
  // GLOBAL por producto, no por sede — comparado contra el stock de la
  // sede seleccionada (o la suma de todas si no hay ninguna elegida),
  // mismo criterio que ya usa la columna "Stock" de Inventario.tsx.
  minStock: number;
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
    minStock: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

ProductSchema.index({ name: "text", sku: "text" });

export const Product = model<IProduct>("Product", ProductSchema);
