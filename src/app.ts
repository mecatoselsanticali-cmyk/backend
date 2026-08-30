import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import path from "path";
import posRoutes from "./routes/posRoutes";
import adminRoutes from "./routes/adminRoutes";

const app = express();

app.use(
  helmet({
    // crossOriginResourcePolicy en "same-site" bloquearía que el frontend
    // (otro puerto/origen en dev) cargue las imágenes servidas aquí.
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

// CORS con credentials:true es OBLIGATORIO para que el navegador envíe/reciba
// las cookies httpOnly de sesión (admin_token/cashier_token) en peticiones
// cross-origin. Con credentials:true, el origin NO puede ser "*" — debe ser
// una lista explícita. CORS_ORIGIN admite varios separados por coma.
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5174")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Legado: fotos de producto subidas ANTES de migrar a Cloudinary (ver
// punto 41 de backend/CLAUDE.md) siguen siendo archivos locales en
// `uploads/products/`, y sus `Product.imageUrl` en Mongo todavía apuntan
// acá — este mount se queda para que esas sigan cargando. Ninguna subida
// NUEVA escribe en este directorio; `uploadProductImage`
// (uploadController.ts) ya sube directo a Cloudinary. Si en algún
// momento se migran esas imágenes viejas a Cloudinary (reemplazando su
// `imageUrl` en la base), este mount deja de tener uso y se puede quitar
// junto con la carpeta `uploads/`.
app.use("/uploads", express.static(path.join(__dirname, "../uploads")));

app.get("/health", (_req, res) => res.json({ status: "ok", service: "mecatos-backend" }));

app.use("/api/pos", posRoutes);
app.use("/api/admin", adminRoutes);

// Manejador de errores centralizado
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[Error]", err);
  res.status(err.status || 500).json({ error: err.message || "Error interno del servidor" });
});

export default app;
