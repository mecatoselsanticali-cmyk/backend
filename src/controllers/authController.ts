import { Request, Response } from "express";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt, { SignOptions } from "jsonwebtoken";
import ms from "ms";
import { User } from "../models/User";
import { Branch } from "../models/Branch";
import { setAuthCookie, clearAuthCookie } from "../utils/cookies";
import { sendPasswordResetEmail } from "../utils/mailer";

const ADMIN_TOKEN_TTL = process.env.JWT_EXPIRES_IN || "8h";
const POS_TOKEN_TTL = process.env.POS_SESSION_EXPIRES_IN || "12h";
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hora

/** POST /api/admin/auth/login  { email, password } */
export async function adminLogin(req: Request, res: Response) {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email y contraseña son requeridos" });
  }

  const user = await User.findOne({ email, role: { $in: ["ADMIN", "MANAGER"] } }).select(
    "+password"
  );

  if (!user || !user.password) {
    return res.status(401).json({ error: "Credenciales inválidas" });
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: "Credenciales inválidas" });
  }

  const token = jwt.sign(
    { userId: user._id, role: user.role, branchId: user.branchId },
    process.env.JWT_SECRET as string,
    { expiresIn: ADMIN_TOKEN_TTL as SignOptions["expiresIn"] }
  );

  // El token va SOLO en una cookie httpOnly — nunca en el body de la
  // respuesta, para que ningún script en el navegador pueda leerlo.
  setAuthCookie(res, "admin_token", token, ms(ADMIN_TOKEN_TTL));

  return res.json({
    user: { id: user._id, name: user.name, role: user.role, branchId: user.branchId },
  });
}

/** GET /api/admin/auth/me -> perfil del admin autenticado (verifica la cookie) */
export async function adminMe(req: Request, res: Response) {
  const admin = req.admin!;
  const user = await User.findById(admin.userId).select("name email role branchId active");

  if (!user || !user.active) {
    return res.status(401).json({ error: "Sesión inválida" });
  }

  return res.json({
    id: user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    branchId: user.branchId,
  });
}

/** POST /api/admin/auth/logout -> limpia la cookie httpOnly */
export async function adminLogout(_req: Request, res: Response) {
  clearAuthCookie(res, "admin_token");
  return res.status(204).send();
}

/**
 * POST /api/admin/auth/forgot-password  { email }
 *
 * Solo ADMIN/MANAGER pueden recuperar contraseña — un cajero no tiene
 * `email`/`password` (usa PIN, ver `posLogin`), así que ni siquiera puede
 * matchear el filtro. La respuesta es siempre el mismo mensaje genérico,
 * exista o no una cuenta con ese correo — no hay forma de que alguien use
 * este endpoint para averiguar qué correos están registrados.
 */
export async function forgotPassword(req: Request, res: Response) {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: "El correo es requerido" });
  }

  const genericResponse = {
    message: "Si el correo existe, se envió un enlace de recuperación",
  };

  const user = await User.findOne({ email, role: { $in: ["ADMIN", "MANAGER"] }, active: true });
  if (!user) {
    return res.json(genericResponse);
  }

  // Se guarda el HASH del token, nunca el token crudo (ver el comentario en
  // User.ts) — el correo lleva el crudo, que solo existe en memoria acá.
  const rawToken = crypto.randomBytes(32).toString("hex");
  user.resetPasswordTokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  user.resetPasswordExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);
  await user.save();

  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5174";
  const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}`;

  // A diferencia de la sincronización con Google Sheets (que es
  // "best-effort", ver punto 21), acá SÍ se espera el envío y se reporta
  // el error tal cual — el usuario hizo clic esperando un correo, no tiene
  // sentido responder éxito si el SMTP está mal configurado.
  try {
    await sendPasswordResetEmail(user.email!, user.name, resetUrl);
  } catch (err) {
    console.error("[forgotPassword] No se pudo enviar el correo de recuperación:", err);
    return res.status(500).json({ error: "No se pudo enviar el correo. Intenta más tarde." });
  }

  return res.json(genericResponse);
}

/** POST /api/admin/auth/reset-password  { token, password } */
export async function resetPassword(req: Request, res: Response) {
  const { token, password } = req.body;

  if (!token || !password) {
    return res.status(400).json({ error: "Token y nueva contraseña son requeridos" });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });
  }

  const tokenHash = crypto.createHash("sha256").update(String(token)).digest("hex");
  const user = await User.findOne({
    resetPasswordTokenHash: tokenHash,
    resetPasswordExpires: { $gt: new Date() },
  }).select("+resetPasswordTokenHash +resetPasswordExpires");

  if (!user) {
    return res.status(400).json({ error: "El enlace es inválido o ya expiró" });
  }

  user.password = await bcrypt.hash(password, 10);
  user.resetPasswordTokenHash = undefined;
  user.resetPasswordExpires = undefined;
  await user.save();

  return res.json({ message: "Contraseña actualizada correctamente" });
}

/** GET /api/pos/auth/branches -> lista de sedes activas para el selector inicial */
export async function listActiveBranches(_req: Request, res: Response) {
  const branches = await Branch.find({ status: true }).select("name address");
  return res.json(branches);
}

/** POST /api/pos/auth/login  { branchId, pin } */
export async function posLogin(req: Request, res: Response) {
  const { branchId, pin } = req.body;

  if (!branchId || !pin) {
    return res.status(400).json({ error: "Sede y PIN son requeridos" });
  }

  const cashiers = await User.find({ branchId, role: "CASHIER", active: true }).select("+pin");

  let matchedUser = null;
  for (const cashier of cashiers) {
    if (cashier.pin && (await bcrypt.compare(pin, cashier.pin))) {
      matchedUser = cashier;
      break;
    }
  }

  if (!matchedUser) {
    return res.status(401).json({ error: "PIN inválido para esta sede" });
  }

  const token = jwt.sign(
    {
      cashierId: matchedUser._id,
      branchId,
      name: matchedUser.name,
      loginAt: new Date().toISOString(),
    },
    process.env.POS_SESSION_SECRET as string,
    { expiresIn: POS_TOKEN_TTL as SignOptions["expiresIn"] }
  );

  setAuthCookie(res, "cashier_token", token, ms(POS_TOKEN_TTL));

  return res.json({
    cashier: { id: matchedUser._id, name: matchedUser.name },
  });
}

/** GET /api/pos/auth/me -> sesión actual del cajero (verifica la cookie) */
export async function posMe(req: Request, res: Response) {
  const session = req.posSession!;
  const branch = await Branch.findById(session.branchId).select("name");

  return res.json({
    cashierId: session.cashierId,
    branchId: session.branchId,
    branchName: branch?.name || "",
    name: session.name,
    loginAt: session.loginAt,
  });
}

/** POST /api/pos/auth/logout -> limpia la cookie httpOnly */
export async function posLogout(_req: Request, res: Response) {
  clearAuthCookie(res, "cashier_token");
  return res.status(204).send();
}
