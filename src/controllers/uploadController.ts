import { Request, Response } from "express";
import { uploadImageToCloudinary } from "../utils/cloudinary";

/**
 * POST /api/admin/uploads/product-image
 * Recibe un archivo (`multipart/form-data`, campo "image") y lo sube a
 * Cloudinary (redimensionado a 800×800 y convertido a WebP del lado de
 * Cloudinary, ver cloudinary.ts) — devuelve la URL pública (`secure_url`).
 * Esa URL es la que se guarda en `Product.imageUrl` y la que el POS
 * consume directamente en el grid de productos — es la MISMA imagen en
 * ambos lados, no hay duplicación. Antes esto guardaba el archivo en
 * disco local (`utils/imageProcessing.ts`, ya eliminado) — ver punto 41
 * de backend/CLAUDE.md para el porqué del cambio y qué pasa con las
 * imágenes que ya quedaron en disco de antes de esta migración.
 */
export async function uploadProductImage(req: Request, res: Response) {
  if (!req.file) {
    return res.status(400).json({ error: "No se recibió ninguna imagen" });
  }

  let imageUrl: string;
  try {
    imageUrl = await uploadImageToCloudinary(req.file.buffer, "products");
  } catch (err) {
    console.error("[uploadProductImage] No se pudo subir la imagen a Cloudinary:", err);
    return res.status(502).json({ error: "No se pudo subir la imagen. Intenta de nuevo." });
  }

  return res.status(201).json({ imageUrl });
}
