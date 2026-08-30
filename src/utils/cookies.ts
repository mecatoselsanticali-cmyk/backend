import { Response } from "express";

/**
 * Único punto donde se deciden las opciones de las cookies de sesión
 * (admin_token, cashier_token). httpOnly:true significa que JavaScript en
 * el navegador NUNCA puede leer estas cookies — es justamente lo que
 * protege el token contra robo vía XSS (a diferencia de guardarlo en
 * localStorage, que cualquier script en la página puede leer).
 *
 * COOKIE_SECURE / COOKIE_SAMESITE son configurables porque el valor
 * correcto depende del despliegue:
 * - Mismo dominio (o solo distinto puerto en localhost) → sameSite "lax",
 *   secure false en dev / true en prod si ya hay HTTPS.
 * - Frontend y backend en dominios DISTINTOS en producción (ej.
 *   app.tudominio.com y api.tudominio.com) → sameSite DEBE ser "none", lo
 *   cual el navegador solo permite si secure=true (requiere HTTPS).
 */
const isProd = process.env.NODE_ENV === "production";

// Si COOKIE_SECURE viene definida explícitamente (incluso como "false"),
// se respeta tal cual — NODE_ENV=production por sí solo NO debe forzar
// secure:true, porque un despliegue recién levantado (ej. docker-compose
// sin reverse proxy con TLS todavía) rompería el login si las cookies
// exigen HTTPS antes de que exista. Solo se infiere de NODE_ENV cuando la
// variable no está definida en absoluto.
const COOKIE_SECURE =
  process.env.COOKIE_SECURE !== undefined
    ? process.env.COOKIE_SECURE === "true"
    : isProd;
const COOKIE_SAMESITE =
  (process.env.COOKIE_SAMESITE as "lax" | "strict" | "none" | undefined) ||
  (COOKIE_SECURE ? "none" : "lax");

export function setAuthCookie(res: Response, name: string, token: string, maxAgeMs: number) {
  res.cookie(name, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    maxAge: maxAgeMs,
    path: "/",
  });
}

export function clearAuthCookie(res: Response, name: string) {
  res.clearCookie(name, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: COOKIE_SAMESITE,
    path: "/",
  });
}
