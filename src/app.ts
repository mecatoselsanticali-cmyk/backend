import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import path from "path";
import posRoutes from "./routes/posRoutes";
import adminRoutes from "./routes/adminRoutes";
import { allowedOrigins, getTrustProxySetting } from "./config/security";
import { rejectMongoOperators } from "./middlewares/sanitizeInput";
import { requireAllowedOrigin } from "./middlewares/originGuard";

const app = express();

// Render (y cualquier PaaS) pone un proxy delante: sin esto `req.ip` es la IP
// del balanceador y el rate limiting no distingue clientes. Ver
// getTrustProxySetting() en config/security.ts y el punto 68 de CLAUDE.md.
app.set("trust proxy", getTrustProxySetting());

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
// una lista explícita (CORS_ORIGIN, separada por comas; validada al arrancar
// en config/security.ts, que además rechaza un "*").
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Todo lo de /api son respuestas con datos de sesión/negocio: que ningún
// navegador o proxy intermedio las guarde en caché.
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
// Anti-CSRF (defensa en profundidad, ver originGuard.ts) y anti-inyección
// NoSQL (rechaza claves `$`/con punto en body/query/params) — antes de las rutas.
app.use("/api", requireAllowedOrigin);
app.use("/api", rejectMongoOperators);

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

// Manejador de errores centralizado. En producción los errores 5xx NO
// devuelven `err.message` (puede traer rutas, consultas o detalles de Mongo);
// el detalle queda solo en el log del servidor.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[Error]", err);
  let status = err.status || err.statusCode || 500;
  let message = err.message || "Error interno del servidor";
  if (err.name === "CastError") {
    status = 400;
    message = "Identificador o valor inválido";
  } else if (err.name === "MulterError") {
    status = 400;
  }
  if (status >= 500 && process.env.NODE_ENV === "production") {
    message = "Error interno del servidor";
  }
  res.status(status).json({ error: message });
});

export default app;
