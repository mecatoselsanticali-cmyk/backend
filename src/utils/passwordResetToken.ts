import crypto from "crypto";

/**
 * Generación del token de "configura/recupera tu contraseña" — punto único
 * de esta lógica, compartida por `forgotPassword` (authController.ts) y por
 * el correo de bienvenida que dispara `createUser` para ADMIN/MANAGER
 * nuevos (adminController.ts, ver punto 59 de backend/CLAUDE.md). Antes
 * solo vivía inline dentro de `forgotPassword`; se extrajo acá para que
 * ambos flujos generen el token exactamente igual — los consume el mismo
 * endpoint (`resetPassword`), así que conviene que la duración/formato no
 * puedan desincronizarse entre los dos sitios que lo generan.
 *
 * Solo genera el token — no toca la base de datos ni sabe nada de `User`.
 * El caller es responsable de guardar `tokenHash`/`expires` en el usuario
 * (`user.resetPasswordTokenHash`/`user.resetPasswordExpires`) y de
 * `.save()`, y de mandar `rawToken` (nunca `tokenHash`) por correo — el
 * hash es lo único que se persiste, igual que ya documentaba el
 * comentario original en `forgotPassword`.
 */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

export function generateResetToken() {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  return { rawToken, tokenHash, expires };
}
