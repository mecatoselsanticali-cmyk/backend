import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export interface PosSessionPayload {
  cashierId: string;
  branchId: string;
  name: string;
  loginAt: string; // ISO date — momento en que inició esta sesión de PIN
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      posSession?: PosSessionPayload;
    }
  }
}

/**
 * Autenticación ligera para el cajero: PIN + sede, verificada leyendo el JWT
 * desde la cookie httpOnly `cashier_token` (no desde Authorization header).
 */
export function requirePosSession(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.cashier_token;

  if (!token) {
    return res.status(401).json({ error: "Sesión de caja no iniciada" });
  }

  try {
    const payload = jwt.verify(
      token,
      process.env.POS_SESSION_SECRET as string
    ) as PosSessionPayload;
    req.posSession = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Sesión de caja inválida o expirada" });
  }
}
