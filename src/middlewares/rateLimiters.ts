import rateLimit, { Options } from "express-rate-limit";
import { Request } from "express";

const WINDOW_15_MIN = 15 * 60 * 1000;
const WINDOW_1_HOUR = 60 * 60 * 1000;

const tooMany = (message: string): Partial<Options> => ({
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`[Security] Rate limit alcanzado: ${req.method} ${req.originalUrl} ip=${req.ip}`);
    res.status(429).json({ error: message });
  },
});

// Texto normalizado de un campo del body, para usarlo como parte de la llave
// del limitador (nunca se confía en que sea string: el body aún no está validado).
const bodyField = (req: Request, field: string) => {
  const v = req.body?.[field];
  return typeof v === "string" ? v.trim().toLowerCase().slice(0, 254) : "";
};

/**
 * Login de admin/gerente: 10 intentos FALLIDOS cada 15 min por IP + correo
 * (los exitosos no cuentan, así un usuario legítimo nunca se bloquea solo).
 */
export const adminLoginLimiter = rateLimit({
  windowMs: WINDOW_15_MIN,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}|${bodyField(req, "email")}`,
  ...tooMany("Demasiados intentos de ingreso. Intenta de nuevo en 15 minutos."),
});

/**
 * Login por PIN del cajero. Un PIN de 4 dígitos son solo 10.000 combinaciones,
 * por eso hay DOS limitadores: por IP (el más habitual) y por sede (frena un
 * ataque repartido entre varias IPs contra la misma sede). Los intentos
 * exitosos no cuentan.
 */
export const posLoginIpLimiter = rateLimit({
  windowMs: WINDOW_15_MIN,
  limit: 10,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}`,
  ...tooMany("Demasiados intentos de PIN. Intenta de nuevo en 15 minutos."),
});

export const posLoginBranchLimiter = rateLimit({
  windowMs: WINDOW_15_MIN,
  limit: 30,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `branch|${typeof req.body?.branchId === "string" ? req.body.branchId.slice(0, 40) : ""}`,
  ...tooMany("Demasiados intentos de PIN en esta sede. Intenta de nuevo en 15 minutos."),
});

/** Recuperar contraseña: 5 solicitudes por hora por IP, y 3 por hora por correo (evita llenar de correos a un admin). */
export const forgotPasswordIpLimiter = rateLimit({
  windowMs: WINDOW_1_HOUR,
  limit: 5,
  keyGenerator: (req) => `${req.ip}`,
  ...tooMany("Demasiadas solicitudes de recuperación. Intenta de nuevo más tarde."),
});

export const forgotPasswordEmailLimiter = rateLimit({
  windowMs: WINDOW_1_HOUR,
  limit: 3,
  keyGenerator: (req) => `email|${bodyField(req, "email")}`,
  ...tooMany("Demasiadas solicitudes de recuperación. Intenta de nuevo más tarde."),
});

/** Restablecer contraseña con token: frena la adivinanza del token. */
export const resetPasswordLimiter = rateLimit({
  windowMs: WINDOW_15_MIN,
  limit: 10,
  keyGenerator: (req) => `${req.ip}`,
  ...tooMany("Demasiados intentos. Intenta de nuevo en 15 minutos."),
});
