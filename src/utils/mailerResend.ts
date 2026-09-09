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

// Mismo logo que usa `Login.tsx`/`AuthShell.tsx` en el frontend
// (`admin-frontend/public/img/logo-santi-trimmed.png`) — no se copia el
// archivo al backend ni se adjunta al correo, se referencia por URL
// (el frontend ya lo sirve como asset estático público). Requiere que
// `FRONTEND_URL` sea la URL real del frontend desplegado — con el
// default de `localhost:5174` el logo simplemente no carga en un
// cliente de correo real (nadie fuera de esta máquina puede pedirle una
// imagen a tu propio localhost), pero el resto del correo sigue
// funcionando igual (el `alt` queda como texto de respaldo).
const LOGO_URL = `${process.env.FRONTEND_URL || "http://localhost:5174"}/img/logo-santi-trimmed.webp`;

export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string) {
  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: "Recupera tu contraseña — Mecatos el Santi",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <img src="${LOGO_URL}" alt="Mecatos el Santi" style="display: block; width: 160px; max-width: 100%; margin: 0 auto 16px;" />
        <h2 style="color: #ea580c; text-align: center;">Mecatos el Santi</h2>
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

// "Administrador"/"Gerente de sede" — mismas etiquetas en español que ya
// usa `roleLabels` en `admin-frontend/src/layout/Sidebar.tsx`; no se
// importa desde ahí (backend/frontend son paquetes separados) así que se
// repite acá, mismo criterio que el resto de mapas de etiquetas chicos
// duplicados en este proyecto.
const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrador",
  MANAGER: "Gerente de sede",
};

/**
 * Correo de bienvenida para un ADMIN/MANAGER recién creado desde Personal
 * (ver punto 59 de backend/CLAUDE.md) — dispara `createUser`
 * (`adminController.ts`), nunca `updateUser` (edición de un usuario
 * existente). A propósito NO lleva la contraseña en texto plano que el
 * admin haya asignado al crear el usuario — mismo motivo que cualquier
 * "no mandes contraseñas por correo": el correo no es un canal que este
 * proyecto pueda garantizar seguro extremo a extremo (queda guardado en la
 * bandeja de entrada indefinidamente, pasa por la infraestructura de
 * Resend, etc.). En su lugar, reutiliza el mecanismo de "olvidé mi
 * contraseña" ya existente (`generateResetToken()`,
 * `utils/passwordResetToken.ts`) — el link de este correo es válido para
 * el mismo endpoint `POST /auth/reset-password` que ya usa esa
 * recuperación, sin ningún cambio de backend adicional.
 */
export async function sendWelcomeEmail(to: string, name: string, role: string, setupUrl: string) {
  const roleLabel = ROLE_LABELS[role] || role;

  const { error } = await resend.emails.send({
    from: FROM_ADDRESS,
    to,
    subject: "Bienvenido a Mecatos el Santi",
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto;">
        <img src="${LOGO_URL}" alt="Mecatos el Santi" style="display: block; width: 160px; max-width: 100%; margin: 0 auto 16px;" />
        <h2 style="color: #ea580c; text-align: center;">Mecatos el Santi</h2>
        <p>Hola ${name},</p>
        <p>Te damos la bienvenida — te registraron como <strong>${roleLabel}</strong> en el panel administrativo de Mecatos el Santi.</p>
        <div style="background: #fff7ed; border: 1px solid #fed7aa; border-radius: 8px; padding: 12px 16px; margin: 16px 0;">
          <p style="margin: 0 0 4px;"><strong>Correo de acceso:</strong> ${to}</p>
          <p style="margin: 0; color: #737373; font-size: 13px;">Por seguridad, configura tu propia contraseña con el botón de abajo antes de tu primer ingreso — nunca la incluimos en un correo.</p>
        </div>
        <p>
          <a
            href="${setupUrl}"
            style="display: inline-block; background: #ea580c; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 8px; font-weight: bold;"
          >
            Configurar mi contraseña
          </a>
        </p>
        <p>Este enlace vence en 1 hora. Si expira, puedes pedir uno nuevo desde "¿Olvidaste tu contraseña?" en la pantalla de acceso.</p>
        <p style="color: #737373; font-size: 12px;">Si el botón no funciona, copia y pega este enlace en tu navegador: ${setupUrl}</p>
        <p style="color: #a3a3a3; font-size: 11px; margin-top: 24px; text-align: center;">© ${new Date().getFullYear()} Mecatos el Santi. Si tienes dudas, contacta a quien administra tu cuenta.</p>
      </div>
    `,
  });

  if (error) {
    throw new Error(error.message || "Resend no pudo enviar el correo");
  }
}
