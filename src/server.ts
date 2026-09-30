import "dotenv/config";
import app from "./app";
import { connectDB } from "./config/db";
import { validateSecurityConfig } from "./config/security";
import { startDianWorker } from "./workers/dianWorker";

const PORT = process.env.PORT || 4000;

async function bootstrap() {
  try {
    validateSecurityConfig();
    await connectDB();
    // Único punto de entrada del backend: Express para HTTP y el worker DIAN
    // (BullMQ) corren en el mismo proceso. Render solo necesita este Web
    // Service para mantener ambos despiertos — antes había un Background
    // Worker aparte con su propio health check.
    startDianWorker();
    app.listen(PORT, () => {
      console.log(`[Server] Mecatos ERP backend corriendo en http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("[Server] Error fatal al iniciar:", err);
    process.exit(1);
  }
}

bootstrap();
