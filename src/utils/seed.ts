import "dotenv/config";
import bcrypt from "bcryptjs";
import { connectDB } from "../config/db";
import { Branch } from "../models/Branch";
import { User } from "../models/User";
import { Product } from "../models/Product";
import mongoose from "mongoose";

async function seed() {
  await connectDB();

  console.log("[Seed] Limpiando colecciones...");
  await Promise.all([Branch.deleteMany({}), User.deleteMany({}), Product.deleteMany({})]);

  console.log("[Seed] Creando sede principal...");
  const branch = await Branch.create({
    name: "Mecatos el Santi — Sede Centro",
    address: "Cra 5 # 10-20, Cali",
    phone: "3001234567",
    dailyCap: 5_000_000,
    dianConfig: {
      prefix: "SETP",
      resolutionNumber: "18760000001",
      from: 1,
      to: 100000,
      current: 1,
      techKey: "mock-tech-key",
    },
    status: true,
  });

  console.log("[Seed] Creando usuarios...");
  await User.create([
    {
      name: "Administrador General",
      role: "ADMIN",
      email: "admin@mecatoselsanti.com",
      password: await bcrypt.hash("admin1234", 10),
      // El administrador no se asigna a ninguna sede — ve todas.
    },
    {
      name: "Gerente Sede Centro",
      role: "MANAGER",
      email: "gerente@mecatoselsanti.com",
      password: await bcrypt.hash("gerente1234", 10),
      branchId: branch._id,
    },
    {
      name: "Cajero Demo",
      role: "CASHIER",
      pin: await bcrypt.hash("1234", 10),
      branchId: branch._id,
    },
  ]);

  console.log("[Seed] Creando productos de catálogo...");
  await Product.create([
    {
      name: "Pandebono",
      sku: "PAN-001",
      category: "Panadería",
      price: 2500,
      taxType: "INC",
      taxRate: 0.08,
    },
    {
      name: "Buñuelo",
      sku: "PAN-002",
      category: "Panadería",
      price: 2000,
      taxType: "INC",
      taxRate: 0.08,
    },
    {
      name: "Café Americano",
      sku: "BEB-001",
      category: "Bebidas",
      price: 4000,
      taxType: "INC",
      taxRate: 0.08,
      modifiers: [{ name: "Extra shot", extraPrice: 1500 }],
    },
    {
      name: "Sandwich Jamón y Queso",
      sku: "SAN-001",
      category: "Comidas",
      price: 9500,
      taxType: "INC",
      taxRate: 0.08,
      modifiers: [
        { name: "Sin cebolla", extraPrice: 0 },
        { name: "Extra queso", extraPrice: 2000 },
      ],
    },
  ]);

  console.log("[Seed] Listo. Credenciales de prueba:");
  console.log("  Admin   -> admin@mecatoselsanti.com / admin1234");
  console.log("  Gerente -> gerente@mecatoselsanti.com / gerente1234");
  console.log("  Cajero  -> Sede: Mecatos el Santi — Sede Centro / PIN: 1234");

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error("[Seed] Error:", err);
  process.exit(1);
});
