import { Request, Response, NextFunction } from "express";

const MAX_DEPTH = 10;

/**
 * Detecta claves que Mongo interpretaría como operador (`$ne`, `$gt`,
 * `$where`…) o como ruta anidada (`a.b`) dentro de un valor controlado por el
 * cliente. Un login con `{"email": {"$ne": null}}` o `?branchId[$ne]=x` es la
 * forma clásica de inyección NoSQL: el valor deja de ser un string y pasa a
 * ser un filtro. Ningún payload legítimo de esta API usa claves así.
 */
function hasMongoOperatorKeys(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object") return false;
  if (depth > MAX_DEPTH) return true; // estructura anómala: se rechaza
  if (Array.isArray(value)) return value.some((v) => hasMongoOperatorKeys(v, depth + 1));
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (key.startsWith("$") || key.includes(".")) return true;
    if (hasMongoOperatorKeys(inner, depth + 1)) return true;
  }
  return false;
}

/**
 * Rechaza (400) cualquier petición cuyo body/query/params traiga claves de
 * operador de Mongo. Se prefiere rechazar a "limpiar en silencio" (lo que
 * hace express-mongo-sanitize): así un intento de inyección queda visible en
 * los logs en vez de convertirse en una consulta distinta a la esperada.
 */
export function rejectMongoOperators(req: Request, res: Response, next: NextFunction) {
  if (
    hasMongoOperatorKeys(req.body) ||
    hasMongoOperatorKeys(req.query) ||
    hasMongoOperatorKeys(req.params)
  ) {
    console.warn(`[Security] Entrada con operadores Mongo rechazada: ${req.method} ${req.path} ip=${req.ip}`);
    return res.status(400).json({ error: "Entrada inválida" });
  }
  next();
}
