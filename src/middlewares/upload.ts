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
    // Solo formatos de imagen raster — `image/svg+xml` puede llevar scripts
    // embebidos, y aquí no hace falta (las fotos de producto son jpg/png/webp).
    if (!file.mimetype.startsWith("image/") || file.mimetype === "image/svg+xml") {
      // `status: 400` para que el manejador de errores no lo trate como un 500.
      return cb(Object.assign(new Error("El archivo debe ser una imagen (jpg, png, webp, etc.)"), { status: 400 }));
    }
    cb(null, true);
  },
});

export const imageUploadMiddleware = upload.single("image");
