import multer from "multer";

/**
 * Middleware genérico de subida de imágenes — `memoryStorage()`, nunca
 * toca disco: el archivo llega como `req.file.buffer` y de ahí se sube
 * directo a Cloudinary (`utils/cloudinary.ts`, ver punto 41 de
 * backend/CLAUDE.md). Hoy el único consumidor es la foto de producto
 * (`uploadController.ts`), pero cualquier otra subida de imagen puede
 * reutilizar este mismo middleware. Siempre espera el archivo en el
 * campo "image".
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("El archivo debe ser una imagen (jpg, png, webp, etc.)"));
    }
    cb(null, true);
  },
});

export const imageUploadMiddleware = upload.single("image");
