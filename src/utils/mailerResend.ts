import { Resend } from "resend";

/**
 * Versión de PRUEBA de `sendPasswordResetEmail` usando Resend (API HTTP,
 * puerto 443) en vez de SMTP directo (`mailer.ts`, nodemailer). Se creó
 * porque el SMTP de Gmail quedó bloqueado en Render — primero
 * `ENETUNREACH` (Render no rutea IPv6 y nodemailer solo encontraba la
 * dirección IPv6 de Gmail), y después de forzar IPv4 manualmente,
 * `ETIMEDOUT` en la conexión (el puerto 465 sale bloqueado por el
 * firewall de salida de Render — patrón típico de host que bloquea
 * puertos de SMTP para evitar spam, no arreglable desde el código). Una
 * API HTTP como Resend evita el problema de raíz: nunca abre un socket
 * SMTP, todo viaja sobre HTTPS (443), que ningún host bloquea.
 *
 * **`mailer.ts` (SMTP/nodemailer) NO se tocó ni se borró** — sigue ahí
 * completo. Este archivo es la alternativa a probar; `authController.ts`
 * decide cuál de los dos usar según de dónde importe
 * `sendPasswordResetEmail`. Si Resend funciona en producción, `mailer.ts`
 * queda obsoleto (se puede borrar en un commit aparte); si no, se revierte
 * el import de `authController.ts` de vuelta a `./mailer` sin perder nada.
 *
 * **Cuenta de Resend en modo de prueba**: sin verificar un dominio propio,
 * Resend solo permite mandar correos a la dirección con la que se creó la
 * cuenta (no a cualquier destinatario) y obliga a usar su remitente
 * genérico `onboarding@resend.dev` — suficiente para esta prueba, pero no
 * para producción real con usuarios reales. Verificar un dominio propio
 * (agregar registros DNS TXT/MX que da su dashboard) quita ambas
 * restricciones.
 */
const resend = new Resend(process.env.RESEND_API_KEY);

const FROM_ADDRESS = process.env.RESEND_FROM || "Mecatos el Santi <onboarding@resend.dev>";

export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string) {
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: "Recupera tu contraseña — Mecatos el Santi",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <h2 style="color: #ea580c;">Mecatos el Santi</h2>
        <p>Hola ${name},</p>
        <p>Recibimos una solicitud para restablecer tu contraseña del panel administrativo.</p>
        <p>
          <a
            href="${resetUrl}"
            style="display: inline-block; background: #ea580c; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold;"
          >
            Restablecer contraseña
          </a>
        </p>
        <p>Este enlace vence en 1 hora. Si tú no pediste este cambio, puedes ignorar este correo — tu contraseña actual sigue funcionando.</p>
        <p style="color: #737373; font-size: 12px;">Si el botón no funciona, copia y pega este enlace en tu navegador: ${resetUrl}</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(error.message || "Resend no pudo enviar el correo");
  }
}
