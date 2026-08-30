import { Schema, model, Document, Types } from "mongoose";

export type UserRole = "ADMIN" | "MANAGER" | "CASHIER";

export interface IUser extends Document {
  name: string;
  role: UserRole;
  pin?: string; // hash de 4 dígitos (cajeros)
  email?: string;
  password?: string; // hash bcrypt (admins/managers)
  branchId?: Types.ObjectId; // requerido para MANAGER/CASHIER, ausente para ADMIN
  active: boolean;
  // Recuperación de contraseña (solo ADMIN/MANAGER, ver authController.ts
  // forgotPassword/resetPassword) — se guarda el HASH sha256 del token, no
  // el token en sí, para que un volcado de la base no alcance para
  // reutilizarlo (el correo solo lleva el token crudo, nunca persistido).
  resetPasswordTokenHash?: string;
  resetPasswordExpires?: Date;
  comparePin(rawPin: string): Promise<boolean>;
  comparePassword(rawPassword: string): Promise<boolean>;
}

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    role: {
      type: String,
      enum: ["ADMIN", "MANAGER", "CASHIER"],
      required: true,
    },
    pin: { type: String, select: false },
    email: { type: String, lowercase: true, trim: true, sparse: true, unique: true },
    password: { type: String, select: false },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      // Un administrador no está atado a ninguna sede; gerentes y cajeros sí.
      required: function (this: IUser) {
        return this.role !== "ADMIN";
      },
    },
    active: { type: Boolean, default: true },
    resetPasswordTokenHash: { type: String, select: false },
    resetPasswordExpires: { type: Date, select: false },
  },
  { timestamps: true }
);

UserSchema.methods.comparePin = async function (rawPin: string) {
  const bcrypt = await import("bcryptjs");
  if (!this.pin) return false;
  return bcrypt.compare(rawPin, this.pin);
};

UserSchema.methods.comparePassword = async function (rawPassword: string) {
  const bcrypt = await import("bcryptjs");
  if (!this.password) return false;
  return bcrypt.compare(rawPassword, this.password);
};

export const User = model<IUser>("User", UserSchema);
