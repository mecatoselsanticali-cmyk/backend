import { Router } from "express";
import {
  listActiveBranches,
  posLogin,
  posMe,
  posLogout,
  completePosOnboarding,
} from "../controllers/authController";
import {
  getCatalog,
  createSale,
  syncOfflineSales,
  getDailyTotal,
  registerPettyCashExpense,
  registerStockLoss,
  listCashierSales,
} from "../controllers/posController";
import {
  createPurchase,
  listCashierPurchases,
  listProductsForPurchase,
} from "../controllers/purchaseController";
import {
  openShift,
  closeShift,
  getStockSnapshot,
  adjustStockCount,
  getShiftSummary,
  getCurrentShift,
} from "../controllers/cashClosureController";
import { requirePosSession } from "../middlewares/posAuth";
import { asyncHandler } from "../utils/asyncHandler";

const router = Router();

// Auth (sin sesión previa)
router.get("/auth/branches", asyncHandler(listActiveBranches));
router.post("/auth/login", asyncHandler(posLogin));
router.post("/auth/logout", asyncHandler(posLogout)); // limpia la cookie aunque ya haya expirado
router.get("/auth/me", requirePosSession, asyncHandler(posMe));
router.patch(
  "/auth/onboarding-complete",
  requirePosSession,
  asyncHandler(completePosOnboarding)
);

// Catálogo
router.get("/catalog", requirePosSession, asyncHandler(getCatalog));

// Ventas
router.post("/sales", requirePosSession, asyncHandler(createSale));
router.post("/sales/sync-batch", requirePosSession, asyncHandler(syncOfflineSales));
router.get("/sales/daily-total", requirePosSession, asyncHandler(getDailyTotal));
router.get("/sales/history", requirePosSession, asyncHandler(listCashierSales));

// Turnos / Arqueo
router.get("/shifts/current", requirePosSession, asyncHandler(getCurrentShift));
router.post("/shifts/open", requirePosSession, asyncHandler(openShift));
router.post("/shifts/:id/close", requirePosSession, asyncHandler(closeShift));
router.get("/shifts/:id/summary", requirePosSession, asyncHandler(getShiftSummary));
router.get("/stock-snapshot", requirePosSession, asyncHandler(getStockSnapshot));
router.post("/stock-snapshot/adjust", requirePosSession, asyncHandler(adjustStockCount));

// Gastos menores
router.post("/expenses", requirePosSession, asyncHandler(registerPettyCashExpense));

// Mermas de stock (producto dañado/vencido, consumo interno de un
// empleado, etc.) — reduce ProductStock sin una venta detrás
router.post("/stock-losses", requirePosSession, asyncHandler(registerStockLoss));

// Compras del día (pestaña "Compras" del cajero) — producto + cantidad,
// ligadas a inventario (ver createPurchase en purchaseController.ts)
router.post("/purchases", requirePosSession, asyncHandler(createPurchase));
router.get("/purchases", requirePosSession, asyncHandler(listCashierPurchases));
router.get("/products", requirePosSession, asyncHandler(listProductsForPurchase));

export default router;
