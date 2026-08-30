import IORedis from "ioredis";

/**
 * Soporta dos formas de configurar Redis:
 * 1. REDIS_URL completa (recomendado en producción con proveedores managed
 *    como Upstash, Redis Cloud, ElastiCache, etc.), ej:
 *    redis://default:password@host:port  ó  rediss://... (con TLS)
 * 2. Host/puerto/password sueltos (cómodo para desarrollo local), ej:
 *    REDIS_HOST=127.0.0.1 / REDIS_PORT=6379
 */
function createConnection() {
  const url = process.env.REDIS_URL;

  const baseOptions = {
    maxRetriesPerRequest: null, // requerido por BullMQ
  };

  if (url) {
    // rediss:// habilita TLS automáticamente (requerido por la mayoría de proveedores managed)
    return new IORedis(url, baseOptions);
  }

  return new IORedis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    ...baseOptions,
  });
}

export const connection = createConnection();

connection.on("error", (err) => {
  console.error("[Redis] Error de conexión:", err.message);
});

connection.on("connect", () => {
  console.log("[Redis] Conectado correctamente");
});
