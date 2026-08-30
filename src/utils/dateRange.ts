/**
 * Único punto de verdad para "zona horaria de Colombia" en el backend —
 * Bogotá es UTC-5 fijo todo el año (Colombia no observa horario de
 * verano), así que un offset explícito es tan correcto como usar una
 * librería de timezones, sin la dependencia añadida.
 */
export const COLOMBIA_TIME_ZONE = "America/Bogota";
export const COLOMBIA_UTC_OFFSET = "-05:00";

/**
 * Convierte un string "YYYY-MM-DD" (lo que manda un <input type="date">) al
 * inicio/fin de ESE día calendario en Colombia — con offset explícito
 * (`-05:00`), NO con la zona horaria del proceso de Node/el SO del
 * servidor.
 *
 * Gotcha real que esto evita (versión 1, ya corregida antes): `new
 * Date("2026-08-24")` parsea como medianoche **UTC**, no medianoche local
 * — pero `Date.prototype.setHours` siempre opera en hora **local**.
 * Mezclar ambas (parsear en UTC y después hacer `d.setHours(23,59,59,999)`)
 * produce un rango de horas equivocado en cualquier zona horaria con
 * offset negativo. Ya pasó en `getDashboardMetrics` y en
 * `reportController.ts`.
 *
 * Gotcha real #2 (por qué esta versión ya NO usa el constructor
 * multi-argumento `new Date(y, m-1, d, ...)`): ese constructor resuelve
 * SIEMPRE en la zona horaria "local" del proceso de Node — es decir, la
 * del SO del contenedor/host donde corre el backend, no necesariamente
 * Colombia. Ningún Dockerfile/docker-compose de este proyecto fijaba
 * `TZ`, así que en un host cuyo reloj de sistema no fuera Bogotá (el
 * default de `node:20-alpine`, la imagen base de `backend/Dockerfile`, es
 * UTC), estas funciones daban un resultado silenciosamente incorrecto —
 * la misma clase de bug que este archivo documentaba arriba, solo que
 * dependiente del despliegue en vez de la mezcla UTC/local original. La
 * corrección: construir el `Date` a partir de un string ISO con el offset
 * `-05:00` puesto a mano (`new Date("2026-08-24T00:00:00-05:00")`) — el
 * motor de JS interpreta ese offset sin importar en qué zona horaria esté
 * corriendo el proceso, así que el resultado es correcto sin depender de
 * `process.env.TZ` ni de la config del host/contenedor.
 */
export function startOfLocalDay(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000${COLOMBIA_UTC_OFFSET}`);
}

export function endOfLocalDay(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999${COLOMBIA_UTC_OFFSET}`);
}

/**
 * El día calendario actual en Colombia, como "YYYY-MM-DD" — sin importar
 * la zona horaria del proceso de Node. `toLocaleDateString("en-CA", ...)`
 * con esa zona explícita es lo único en este archivo que sí depende de la
 * zona horaria vía `Intl`, pero a diferencia del offset fijo de arriba,
 * acá hace falta el nombre de la zona (no un offset) porque el punto es
 * justamente preguntar "¿qué día es HOY en Bogotá" a partir de un
 * instante UTC (`Date.now()`), y `en-CA` da el formato `YYYY-MM-DD`
 * directamente sin tener que reordenar `DD/MM/YYYY`.
 */
export function getTodayColombiaDateString(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: COLOMBIA_TIME_ZONE });
}

/** Medianoche de HOY en Colombia — reemplazo directo de `new Date();
 * d.setHours(0,0,0,0)`, que dependía de la zona horaria del proceso. */
export function getStartOfTodayColombia(): Date {
  return startOfLocalDay(getTodayColombiaDateString());
}