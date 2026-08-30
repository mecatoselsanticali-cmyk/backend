import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface AdminTokenPayload {
  userId: string;
  role: "ADMIN" | "MANAGER";
  branchId?: string; // MANAGER puede estar restringido a una sede
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AdminTokenPayload;
    }
  }
}

/**
 * Verifica el JWT leído desde la cookie httpOnly `admin_token` (no desde el
 * header Authorization — el frontend ya no maneja el token directamente,
 * el navegador lo envía solo porque las peticiones usan withCredentials).
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.admin_token;

  if (!token) {
    return res.status(401).json({ error: "No autenticado" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET as string) as AdminTokenPayload;
    req.admin = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Sesión inválida o expirada" });
  }
}

/** Restringe el acceso a roles específicos (RBAC) */
export function requireRole(...roles: Array<"ADMIN" | "MANAGER">) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.admin || !roles.includes(req.admin.role)) {
      return res.status(403).json({ error: "No tienes permisos para esta acción" });
    }
    next();
  };
}
