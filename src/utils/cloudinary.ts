import { v2 as cloudinary } from "cloudinary";

/**
 * Único punto donde se configura el SDK de Cloudinary — hoy solo lo usa
 * `uploadProductImage` (uploadController.ts), pero cualquier otra imagen
 * que se agregue a futuro (foto de sede, logo, etc.) debería pasar por
 * acá en vez de llamar a `cloudinary.config()` de nuevo en otro archivo.
 *
 * `cloudinary.config()` no valida las credenciales de inmediato (es solo
 * guardar strings en memoria) — si `CLOUDINARY_*` no está configurado
 * todavía, el error real aparece recién en la primera llamada a
 * `uploadImageToCloudinary()`, no al arrancar el servidor. Mismo
 * principio que `mailer.ts` (SMTP) — un entorno de desarrollo que no
 * necesite subir imágenes reales no se rompe por variables vacías.
 */
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Sube un buffer en memoria (viene de `imageUploadMiddleware`, multer con
 * `memoryStorage()` — nunca toca disco antes de esto) a Cloudinary y
 * devuelve la URL pública (`secure_url`, siempre HTTPS). El resize/
 * conversión a WebP que antes hacía `sharp` en `imageProcessing.ts` ahora
 * lo hace Cloudinary del lado del servidor vía `transformation` — incluso
 * el mismo criterio de tamaño (800×800, recorte tipo "cover").
 *
 * `folder` agrupa las imágenes dentro de la cuenta de Cloudinary (ej.
 * "products") — no es una ruta local, es metadata de organización propia
 * de Cloudinary, visible en su dashboard.
 */
export function uploadImageToCloudinary(buffer: Buffer, folder: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: `mecatos-el-santi/${folder}`,
        transformation: [
          { width: 800, height: 800, crop: "fill" },
          { fetch_format: "webp", quality: "auto:good" },
        ],
      },
      (err, result) => {
        if (err || !result) {
          return reject(err || new Error("Cloudinary no devolvió ningún resultado"));
        }
        resolve(result.secure_url);
      }
    );
    uploadStream.end(buffer);
  });
}
