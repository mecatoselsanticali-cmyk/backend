import nodemailer from "nodemailer";
import dns from "dns";

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
 */
const SMTP_HOST = process.env.SMTP_HOST || "smtp.gmail.com";
const SMTP_PORT = Number(process.env.SMTP_PORT) || 465;
const SMTP_SECURE = process.env.SMTP_SECURE !== "false";
const FROM_ADDRESS = process.env.SMTP_FROM || process.env.SMTP_USER;

/**
 * Bug real de producción — Render (y hosts de contenedores similares) le
 * conecta a `smtp.gmail.com` por IPv6 y falla con `ENETUNREACH` porque esa
 * salida no existe ahí. Nodemailer resuelve DNS por su cuenta
 * (`node_modules/nodemailer/lib/shared/index.js`, `resolveHostname`) con
 * una heurística propia (`isFamilySupported`, basada en escanear
 * `os.networkInterfaces()` del proceso) para decidir si vale la pena
 * intentar IPv4 — en el contenedor de Render esa heurística concluye que
 * no, así que solo termina resolviendo/usando la dirección IPv6 de Gmail.
 * **No existe ninguna opción documentada de nodemailer para forzar IPv4**
 * (`family`, `ipVersion`, etc. — confirmado leyendo el código fuente de
 * `smtp-connection/index.js`/`shared/index.js`: nunca leen `options.family`,
 * pasarlo no hace nada aunque TypeScript lo acepte con un cast). La única
 * forma confiable de evitar su resolución interna: `resolveHostname` se
 * salta TODA esa lógica si `host` ya es una IP literal
 * (`net.isIP(options.host)` true) — así que resolvemos la IPv4 nosotros
 * mismos con `dns.promises.resolve4()` y se la pasamos directo. Hace
 * falta `servername` (opción de nivel superior, no anidada en `tls`,
 * también leída directo de `SMTPConnection`) con el hostname real — si no,
 * la validación del certificado TLS falla porque el certificado de Gmail
 * no cubre la IP cruda.
 *
 * Se resuelve de nuevo en cada envío (no se cachea la IP) — el volumen de
 * este correo es bajísimo (solo "olvidé mi contraseña"), así que el costo
 * de un lookup DNS extra por envío no importa, y evita quedarse pegado a
 * una IP vieja si la infraestructura de Gmail cambia.
 */
async function createSmtpTransport() {
  const [ip] = await dns.promises.resolve4(SMTP_HOST);
  if (!ip) {
    throw new Error(`No se pudo resolver una dirección IPv4 para ${SMTP_HOST}`);
  }

  // `servername` (como `family` antes) es una opción real de
  // `SMTPConnection` que su propio paquete no declara en los tipos —
  // armarla en una `const` sin anotar el tipo evita el "excess property
  // check" que sí dispara al pasarla como literal directo a
  // `createTransport(...)`.
  const transportOptions = {
    host: ip,
    servername: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  };

  return nodemailer.createTransport(transportOptions);
}

/**
 * Envía el correo de "recuperar contraseña" — HTML simple, sin plantilla
 * externa ni librería de templating (un solo correo transaccional no lo
 * justifica). El link ya viene armado con el token crudo (ver
 * `forgotPassword` en authController.ts) — este helper no genera ni
 * conoce el token, solo lo manda.
 */
export async function sendPasswordResetEmail(to: string, name: string, resetUrl: string) {
  const transporter = await createSmtpTransport();
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
