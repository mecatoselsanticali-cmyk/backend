import { Request, Response, NextFunction } from "express";
import { allowedOrigins } from "../config/security";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Defensa en profundidad contra CSRF. Con `SameSite=None` (frontend y backend
 * en dominios distintos) el navegador manda las cookies de sesión también
 * desde sitios ajenos. Los navegadores siempre incluyen `Origin` en
 * peticiones que modifican datos, así que si viene y NO es uno de los
 * frontends permitidos (CORS_ORIGIN), se rechaza. Sin `Origin` (curl,
 * herramientas de servidor) la petición pasa: un atacante en un navegador no
 * puede omitirlo, y esas herramientas no llevan las cookies de la víctima.
 */
export function requireAllowedOrigin(req: Request, res: Response, next: NextFunction) {
  if (SAFE_METHODS.has(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    console.warn(`[Security] Origin no permitido rechazado: ${origin} ${req.method} ${req.path}`);
    return res.status(403).json({ error: "Origen no permitido" });
  }
  next();
}
