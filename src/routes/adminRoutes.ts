import { Router } from "express";
import {
  adminLogin,
  adminMe,
  adminLogout,
  forgotPassword,
  resetPassword,
  completeAdminOnboarding,
} from "../controllers/authController";
import { requireAdminAuth, requireRole } from "../middlewares/adminAuth";
import { asyncHandler } from "../utils/asyncHandler";
import { imageUploadMiddleware } from "../middlewares/upload";
import { uploadProductImage } from "../controllers/uploadController";
import {
  listPurchasesAdmin,
  createPurchaseAdmin,
  updatePurchaseAdmin,
  deletePurchaseAdmin,
  listPurchaseProducts,
  listPurchaseUsers,
} from "../controllers/purchaseController";
import {
  listCashClosuresAdmin,
  getCashClosureDetail,
  createCashClosureAdmin,
  updateCashClosureAdmin,
  deleteCashClosureAdmin,
  listCashiersForClosures,
} from "../controllers/cashClosureController";
import { exportReport } from "../controllers/reportController";
import {
  listBranches,
  createBranch,
  updateBranch,
  listProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  getProductStock,
  addProductStock,
  listUsers,
  createUser,
  getDashboardKpis,
  getDashboardMetrics,
  listSales,
  listSaleUsers,
  createSaleAdmin,
  updateSaleAdmin,
  cancelSaleAdmin,
  confirmSalePayment,
  listPayables,
  createPayable,
  listReceivables,
  createReceivable,
  listExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  updateUser,
} from "../controllers/adminController";

const router = Router();

// Auth (sin token requerido)
router.post("/auth/login", asyncHandler(adminLogin));
router.post("/auth/logout", asyncHandler(adminLogout)); // limpia la cookie aunque ya haya expirado
router.post("/auth/forgot-password", asyncHandler(forgotPassword));
router.post("/auth/reset-password", asyncHandler(resetPassword));

// A partir de aquí, todas las rutas requieren la cookie admin_token válida
router.use(requireAdminAuth);

router.get("/auth/me", asyncHandler(adminMe));
router.patch("/auth/onboarding-complete", asyncHandler(completeAdminOnboarding));

// Dashboard
router.get("/dashboard/kpis", asyncHandler(getDashboardKpis));
router.get("/dashboard/metrics", asyncHandler(getDashboardMetrics));

// Sedes (solo ADMIN puede crear/editar)
router.get("/branches", asyncHandler(listBranches));
router.post("/branches", requireRole("ADMIN"), asyncHandler(createBranch));
router.put("/branches/:id", requireRole("ADMIN"), asyncHandler(updateBranch));

// Inventario -> Productos
router.get("/products", asyncHandler(listProducts));
router.post("/products", requireRole("ADMIN", "MANAGER"), asyncHandler(createProduct));
router.put("/products/:id", requireRole("ADMIN", "MANAGER"), asyncHandler(updateProduct));
router.delete("/products/:id", requireRole("ADMIN", "MANAGER"), asyncHandler(deleteProduct));
router.get("/products/:id/stock", asyncHandler(getProductStock));
router.post("/products/:id/stock", requireRole("ADMIN", "MANAGER"), asyncHandler(addProductStock));

// Carga de imagen de producto (se usa desde el modal de Inventario)
router.post(
  "/uploads/product-image",
  requireRole("ADMIN", "MANAGER"),
  imageUploadMiddleware,
  asyncHandler(uploadProductImage)
);

// Personal (solo ADMIN — un gerente no gestiona personal de otras sedes)
router.get("/users", requireRole("ADMIN"), asyncHandler(listUsers));
router.post("/users", requireRole("ADMIN"), asyncHandler(createUser));
router.put("/users/:id", requireRole("ADMIN"), asyncHandler(updateUser));

// Ventas
router.get("/sales", asyncHandler(listSales));
router.get("/sales/registrants", asyncHandler(listSaleUsers));
router.post("/sales", requireRole("ADMIN", "MANAGER"), asyncHandler(createSaleAdmin));
router.put("/sales/:id", requireRole("ADMIN", "MANAGER"), asyncHandler(updateSaleAdmin));
router.post("/sales/:id/cancel", requireRole("ADMIN", "MANAGER"), asyncHandler(cancelSaleAdmin));
router.patch("/sales/:id/confirm-payment", requireRole("ADMIN", "MANAGER"), asyncHandler(confirmSalePayment));

// Compras (vista consolidada de lo registrado por los cajeros)
router.get("/purchases", asyncHandler(listPurchasesAdmin));
router.get("/purchases/products", asyncHandler(listPurchaseProducts));
router.get("/purchases/registrants", asyncHandler(listPurchaseUsers));
router.post("/purchases", requireRole("ADMIN", "MANAGER"), asyncHandler(createPurchaseAdmin));
router.put("/purchases/:id", requireRole("ADMIN", "MANAGER"), asyncHandler(updatePurchaseAdmin));
router.delete("/purchases/:id", requireRole("ADMIN", "MANAGER"), asyncHandler(deletePurchaseAdmin));

// Cuentas por Pagar
router.get("/accounts-payable", asyncHandler(listPayables));
router.post("/accounts-payable", requireRole("ADMIN", "MANAGER"), asyncHandler(createPayable));

// Cuentas por Cobrar
router.get("/accounts-receivable", asyncHandler(listReceivables));
router.post("/accounts-receivable", requireRole("ADMIN", "MANAGER"), asyncHandler(createReceivable));

// Gastos
router.get("/expenses", asyncHandler(listExpenses));
router.post("/expenses", requireRole("ADMIN", "MANAGER"), asyncHandler(createExpense));
router.put("/expenses/:id", requireRole("ADMIN", "MANAGER"), asyncHandler(updateExpense));
router.delete("/expenses/:id", requireRole("ADMIN", "MANAGER"), asyncHandler(deleteExpense));

// Finanzas > Caja (aperturas/cierres de turno)
router.get("/cash-closures/cashiers", asyncHandler(listCashiersForClosures));
router.get("/cash-closures", asyncHandler(listCashClosuresAdmin));
router.get("/cash-closures/:id/detail", asyncHandler(getCashClosureDetail));
router.post("/cash-closures", requireRole("ADMIN", "MANAGER"), asyncHandler(createCashClosureAdmin));
router.put("/cash-closures/:id", requireRole("ADMIN", "MANAGER"), asyncHandler(updateCashClosureAdmin));
router.delete("/cash-closures/:id", requireRole("ADMIN", "MANAGER"), asyncHandler(deleteCashClosureAdmin));

// Finanzas > Reportes
router.get("/reports/export", asyncHandler(exportReport));

export default router;
