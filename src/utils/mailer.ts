import nodemailer from "nodemailer";

/**
 * Único punto donde se arma el transporte SMTP — hoy solo lo usa
 * `forgotPassword` (authController.ts), pero cualquier otro correo
 * transaccional que se agregue a futuro debería pasar por acá en vez de
 * crear su propio `nodemailer.createTransport(...)`.
 *
 * Pensado para Gmail (el negocio va a conectar su correo empresarial vía
 * SMTP de Gmail), pero no hay nada específico de Gmail en el código — son
 * variables SMTP genéricas, así que también sirve con cualquier otro
 * proveedor SMTP si el negocio cambia de correo más adelante.
 *
 * Valores para Gmail específicamente (ver backend/CLAUDE.md para el
 * detalle completo del setup):
 * - SMTP_HOST=smtp.gmail.com
 * - SMTP_PORT=465
 * - SMTP_SECURE=true
 * - SMTP_USER=<correo completo de Gmail>
 * - SMTP_PASS=<contraseña de aplicación de 16 caracteres, NUNCA la
 *   contraseña normal de la cuenta — Gmail exige verificación en dos
 *   pasos activada para poder generar una>
 *
 * `createTransport` no abre ninguna conexión de inmediato (nodemailer es
 * perezoso — solo conecta cuando se llama `sendMail`), así que es seguro
 * crear el transporte al cargar el módulo aunque las variables SMTP_*
 * todavía no estén configuradas en un entorno de desarrollo que no
 * necesite probar el envío real de correos.
 */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 465,
  secure: process.env.SMTP_SECURE !== "false",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM_ADDRESS = process.env.SMTP_FROM || process.env.SMTP_USER;

/**
 * Envía el correo de "recuperar contraseña" — HTML simple, sin plantilla
 * externa ni librería de templating (un solo correo transaccional no lo
 * justifica). El link ya viene armado con el token crudo (ver
 * `forgotPassword` en authController.ts) — este helper no genera ni
 * conoce el token, solo lo manda.
 */
export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string) {
  await transporter.sendMail({
    from: `"Mecatos el Santi" <${FROM_ADDRESS}>`,
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
}
