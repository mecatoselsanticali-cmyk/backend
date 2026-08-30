import mongoose from "mongoose";

export async function connectDB(): Promise<void> {
  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error("MONGO_URI no está definida en las variables de entorno");
  }

  mongoose.set("strictQuery", true);

  await mongoose.connect(uri);

  console.log(`[DB] Conectado a MongoDB -> ${mongoose.connection.name}`);

  mongoose.connection.on("error", (err) => {
    console.error("[DB] Error de conexión:", err);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("[DB] Conexión a MongoDB perdida. Reintentando...");
  });
}
