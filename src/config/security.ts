const isProd = process.env.NODE_ENV === "production";

/** Orígenes de frontend permitidos (CORS + chequeo de Origin en peticiones que modifican datos). */
export const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5174")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Cuántos proxies hay delante de Express. Sin esto, detrás de Render `req.ip`
 * sería la IP del balanceador y el rate limiting bloquearía a TODOS los
 * usuarios juntos (o a nadie). Con `1`, Express toma la IP real del cliente
 * de `X-Forwarded-For`. Configurable con TRUST_PROXY (número de saltos,
 * "true"/"false" o una lista de subredes); por defecto 1 en producción y
 * desactivado en local (donde un cliente podría falsificar el header).
 */
export function getTrustProxySetting(): number | boolean | string {
  const raw = process.env.TRUST_PROXY;
  if (raw === undefined || raw === "") return isProd ? 1 : false;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const asNumber = Number(raw);
  return Number.isInteger(asNumber) && asNumber >= 0 ? asNumber : raw;
}

const PLACEHOLDER_SECRETS = ["cambia_este_secreto", "cambia_este_secreto_pos", "changeme", "secret"];

/**
 * Revisa la configuración de seguridad al arrancar. Los errores graves
 * (secretos ausentes, CORS con comodín) detienen el arranque en producción;
 * lo demás (secretos débiles, cookies sin `Secure`) solo advierte, salvo que
 * SECURITY_STRICT=true los convierta en errores — así un despliegue existente
 * con un secreto corto no se cae de golpe, pero queda avisado en los logs.
 */
export function validateSecurityConfig(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const name of ["JWT_SECRET", "POS_SESSION_SECRET"] as const) {
    const value = process.env[name];
    if (!value) {
      errors.push(`${name} no está definido`);
    } else if (value.length < 32 || PLACEHOLDER_SECRETS.includes(value)) {
      warnings.push(`${name} es corto (<32 caracteres) o un valor de ejemplo — genera uno aleatorio largo`);
    }
  }

  if (allowedOrigins.includes("*")) {
    errors.push('CORS_ORIGIN no puede contener "*" — las cookies de sesión exigen una lista explícita');
  }
  if (isProd && !process.env.CORS_ORIGIN) {
    errors.push("CORS_ORIGIN es obligatorio en producción (dominio del frontend)");
  }

  if (isProd) {
    const cookieSecure = process.env.COOKIE_SECURE !== undefined ? process.env.COOKIE_SECURE === "true" : true;
    if (!cookieSecure) warnings.push("COOKIE_SECURE=false en producción — las cookies de sesión viajarían sin HTTPS");
    if (allowedOrigins.some((o) => o.startsWith("http://") && !o.includes("localhost"))) {
      warnings.push("CORS_ORIGIN incluye un origen http:// que no es localhost");
    }
  }

  const strict = process.env.SECURITY_STRICT === "true";
  if (strict) errors.push(...warnings.splice(0));

  warnings.forEach((w) => console.warn(`[Security] ADVERTENCIA: ${w}`));
  if (errors.length > 0) {
    errors.forEach((e) => console.error(`[Security] ERROR: ${e}`));
    if (isProd || strict) {
      throw new Error("Configuración de seguridad inválida — revisa los errores de [Security] arriba");
    }
  }
}
