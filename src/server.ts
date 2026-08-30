import "dotenv/config";
import app from "./app";
import { connectDB } from "./config/db";

const PORT = process.env.PORT || 4000;

async function bootstrap() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`[Server] Mecatos ERP backend corriendo en http://localhost:${PORT}`);
      console.log(`[Server] Recuerda iniciar el worker DIAN por separado: npm run worker:dian`);
    });
  } catch (err) {
    console.error("[Server] Error fatal al iniciar:", err);
    process.exit(1);
  }
}

bootstrap();
