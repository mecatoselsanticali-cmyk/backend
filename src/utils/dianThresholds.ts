// Único punto de verdad para leer THIRTY_MINUTES/MAX_GROUP_1 de forma
// segura — ambos son constantes locales de posController.createSale/
// adminController.createSaleAdmin (ver punto 37 de CLAUDE.md, no
// enlazadas a DIAN_TOPE_CONSUMIDOR_FINAL de dianService), pero leerlas de
// process.env con un Number(...) directo, sin fallback, ya rompió en
// silencio una vez: THIRTY_MINUTES=30 * 60 * 1000 en .env se carga como el
// STRING literal "30 * 60 * 1000" (un .env no evalúa expresiones),
// Number(...) de eso da NaN, y cualquier comparación con NaN es siempre
// false — el cooldown de 30 min entre ventas SPECIAL quedó permanentemente
// "no cumplido" apenas hubo una venta SPECIAL ese día, sin ningún error en
// ningún log. Este helper reemplaza el `Number(process.env.X)` inline en
// ambos controladores: si el valor falta o no es un número real, cae a un
// default conocido-bueno Y lo avisa fuerte en consola, en vez de fallar
// silenciosamente otra vez.
const DEFAULT_THIRTY_MINUTES_MS = 30 * 60 * 1000;
const DEFAULT_MAX_GROUP_1 = 509000;

function parseEnvNumber(envVarName: string, rawValue: string | undefined, fallback: number): number {
  const parsed = Number(rawValue);
  if (rawValue === undefined || rawValue.trim() === "" || Number.isNaN(parsed)) {
    console.warn(
      `[dianThresholds] ${envVarName} inválido o no definido (valor recibido: ${JSON.stringify(
        rawValue
      )}) — usando el default ${fallback}. Revisa backend/.env (o las variables del servicio en Render).`
    );
    return fallback;
  }
  return parsed;
}

/** Cooldown en milisegundos entre ventas "SPECIAL" del Disparador 2 (tope/cooldown diario). */
export function getThirtyMinutesMs(): number {
  return parseEnvNumber("THIRTY_MINUTES", process.env.THIRTY_MINUTES, DEFAULT_THIRTY_MINUTES_MS);
}

/** Tope diario (COP) de ventas "SPECIAL"/"POS_DOC" del Disparador 2 ("Grupo 1"). */
export function getMaxGroup1(): number {
  return parseEnvNumber("MAX_GROUP_1", process.env.MAX_GROUP_1, DEFAULT_MAX_GROUP_1);
}
