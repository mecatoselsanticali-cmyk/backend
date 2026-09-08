import { Request, Response } from "express";
import path from "path";
import fs from "fs";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { Sale } from "../models/Sale";
import { Purchase } from "../models/Purchase";
import { Expense } from "../models/Expense";
import { ProductStock } from "../models/ProductStock";
import { Branch } from "../models/Branch";
import { resolveBranchFilter } from "./adminController";
import { startOfLocalDay, endOfLocalDay, COLOMBIA_TIME_ZONE } from "../utils/dateRange";

/**
 * Reportes financieros (Finanzas > Reportes): resumen + detalle de
 * inventario/ventas/compras/gastos en un rango de fechas, exportable a
 * Excel o PDF — ambos generados en el backend (`exceljs`/`pdfkit`), no en
 * el navegador. Un GERENTE solo ve datos de su propia sede
 * (resolveBranchFilter, igual que el resto del panel admin) — un ADMIN sin
 * sede elegida en el selector de arriba obtiene el reporte de TODAS las
 * sedes combinadas, con `branchId` sin filtrar en cada query (mismo
 * `undefined` = "todas" que ya usa el resto del panel, ver punto 18 de
 * CLAUDE.md raíz); si elige una sede específica, todas las secciones
 * (incluida Inventario) quedan acotadas solo a esa sede.
 *
 * Ver punto 56 de admin-frontend/CLAUDE.md para el detalle del rediseño
 * (logo, tabla de Inventario nueva, estilo "profesional" del PDF).
 */

// Mismo tono que `admin-frontend/src/pages/Dashboard.tsx` (`BRAND`,
// tailwind `brand-600`) — hardcodeado acá porque backend y admin-frontend
// son paquetes separados sin config de Tailwind compartida (ver CLAUDE.md
// raíz), así que no hay un solo lugar de verdad para el color de marca.
const BRAND_COLOR = "#ea580c";
const BRAND_COLOR_LIGHT = "#fff7ed"; // mismo tono que bg-orange-50
const ZEBRA_FILL = "f7f7f6";
const GREEN = "#16a34a";
const RED = "#ef4444";

// pdfkit (0.20.1) y exceljs (`addImage`) solo soportan PNG/JPEG/GIF — WebP
// no (verificado a mano: `doc.image()` con el `.webp` real del proyecto
// tira "Unknown image format"). El logo real del negocio vive en
// `admin-frontend/public/img/` (`.png` Y `.webp` — el `.webp` es más
// liviano y es lo que usa la web, ver admin-frontend/CLAUDE.md punto 11),
// pero backend y admin-frontend son paquetes separados sin assets
// compartidos (no hay workspaces, ver CLAUDE.md raíz) — así que acá se
// guarda una copia local del `.png` en `backend/assets/` (fuera de `src/`
// a propósito: `tsc` no copia archivos no-`.ts` a `dist/`, así que el
// Dockerfile copia `assets/` aparte de `dist/` en la imagen final de
// producción — ver `backend/Dockerfile`).
const LOGO_PATH = path.join(__dirname, "..", "..", "assets", "logo-santi-trimmed.png");
let logoBuffer: Buffer | null = null;
try {
  logoBuffer = fs.readFileSync(LOGO_PATH);
} catch (err) {
  // No debería pasar en un despliegue normal (el archivo va en el repo) —
  // si falta, los reportes se generan igual pero sin logo, en vez de que
  // un problema puramente estético tumbe toda la exportación.
  console.error("[reportController] No se pudo cargar el logo para los reportes:", err);
}

interface InventoryRow {
  sku: string;
  name: string;
  category: string;
  branch: string;
  price: number;
  quantity: number;
  totalValue: number;
}

interface ReportData {
  sales: any[];
  purchases: any[];
  expenses: any[];
  inventory: InventoryRow[];
  totalSales: number;
  totalPurchases: number;
  totalExpenses: number;
  totalInventoryValue: number;
  net: number;
  salesByMethod: Record<string, number>;
  expensesByCategory: Record<string, number>;
}

/**
 * El inventario es una FOTO del stock actual (cuánto hay ahora mismo), no
 * algo delimitado por `from`/`to` como ventas/compras/gastos — `Product`/
 * `ProductStock` no tienen un rango de fechas que filtrar, así que esta
 * consulta solo respeta `branchId` (mismo "todas las sedes si no se elige
 * ninguna" del resto del reporte), nunca `baseFilter`. Solo trae stock con
 * `quantity > 0` de productos activos — mismo criterio que
 * `buildStockSnapshot()` en `cashClosureController.ts` (la verificación de
 * apertura/cierre de turno del cajero), no se reutiliza esa función porque
 * es privada a ese archivo y no soporta "todas las sedes" (siempre recibe
 * un `branchId` puntual).
 */
async function fetchInventoryData(branchId?: string): Promise<InventoryRow[]> {
  const filter: any = { quantity: { $gt: 0 } };
  if (branchId) filter.branchId = branchId;

  const stocks = await ProductStock.find(filter)
    .populate({ path: "productId", match: { active: true }, select: "name sku category price" })
    .populate("branchId", "name")
    .lean();

  return stocks
    .filter((s: any) => s.productId)
    .map((s: any) => ({
      sku: s.productId.sku,
      name: s.productId.name,
      category: s.productId.category,
      branch: s.branchId?.name || "—",
      price: s.productId.price,
      quantity: s.quantity,
      totalValue: s.productId.price * s.quantity,
    }))
    .sort((a: InventoryRow, b: InventoryRow) => a.branch.localeCompare(b.branch) || a.name.localeCompare(b.name));
}

async function fetchReportData(req: Request): Promise<ReportData> {
  const { from, to } = req.query;
  const branchId = resolveBranchFilter(req);

  const dateFilter: any = {};
  if (from) dateFilter.$gte = startOfLocalDay(String(from));
  if (to) dateFilter.$lte = endOfLocalDay(String(to));

  const baseFilter: any = {};
  if (branchId) baseFilter.branchId = branchId;
  if (from || to) baseFilter.createdAt = dateFilter;

  const [sales, purchases, expenses, inventory] = await Promise.all([
    Sale.find({ ...baseFilter, status: "ACTIVE" })
      .sort({ createdAt: 1 })
      .populate("branchId", "name")
      .populate("cashierId", "name")
      .lean(),
    Purchase.find(baseFilter)
      .sort({ createdAt: 1 })
      .populate("branchId", "name")
      .populate("registeredBy", "name")
      .populate("productId", "name")
      .lean(),
    Expense.find(baseFilter)
      .sort({ createdAt: 1 })
      .populate("branchId", "name")
      .populate("registeredBy", "name")
      .lean(),
    fetchInventoryData(branchId),
  ]);

  const totalSales = sales.reduce((sum, s: any) => sum + s.total, 0);
  const totalPurchases = purchases.reduce((sum, p: any) => sum + p.amount, 0);
  const totalExpenses = expenses.reduce((sum, e: any) => sum + e.amount, 0);
  const totalInventoryValue = inventory.reduce((sum, i) => sum + i.totalValue, 0);

  const salesByMethod: Record<string, number> = {};
  for (const s of sales as any[]) {
    salesByMethod[s.paymentMethod] = (salesByMethod[s.paymentMethod] || 0) + s.total;
  }

  const expensesByCategory: Record<string, number> = {};
  for (const e of expenses as any[]) {
    expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + e.amount;
  }

  return {
    sales,
    purchases,
    expenses,
    inventory,
    totalSales,
    totalPurchases,
    totalExpenses,
    totalInventoryValue,
    // Neto es puramente P&L (ventas - compras - gastos) — el valor del
    // inventario NO entra en esta cuenta a propósito: es un activo en
    // existencia (cuánto vale lo que hay en la bodega ahora), no un flujo
    // de caja del período. Se muestra aparte en el resumen, nunca mezclado
    // acá.
    net: totalSales - totalPurchases - totalExpenses,
    salesByMethod,
    expensesByCategory,
  };
}

function money(n: number) {
  return `$${Math.round(n).toLocaleString("es-CO")}`;
}

// Estos reportes son 100% del negocio en Colombia — sin `timeZone` acá,
// `toLocaleString` cae en la zona horaria del proceso de Node (el SO del
// contenedor/host donde corre el backend, no necesariamente Bogotá; ver
// utils/dateRange.ts). Un solo helper para no repetir la opción en cada
// una de las columnas de fecha del Excel/PDF.
function formatBogota(date: Date | string) {
  return new Date(date).toLocaleString("es-CO", { timeZone: COLOMBIA_TIME_ZONE });
}

/** GET /api/admin/reports/export?format=xlsx|pdf&from=&to=&branchId= */
export async function exportReport(req: Request, res: Response) {
  const format = req.query.format === "pdf" ? "pdf" : "xlsx";
  const { from, to } = req.query;
  const branchId = resolveBranchFilter(req);

  const [data, branch] = await Promise.all([
    fetchReportData(req),
    branchId ? Branch.findById(branchId).select("name").lean() : Promise.resolve(null),
  ]);

  const rangeLabel = `${from ? String(from) : "inicio"} — ${to ? String(to) : "hoy"}`;
  const branchLabel = branch?.name || "Todas las sedes";

  if (format === "pdf") {
    return exportPdf(res, data, rangeLabel, branchLabel);
  }
  return exportExcel(res, data, rangeLabel, branchLabel);
}

/* ------------------------------- Excel ---------------------------------- */

const MONEY_FMT = '"$"#,##0';

function styleHeaderRow(row: ExcelJS.Row) {
  row.font = { bold: true, color: { argb: "FFFFFFFF" } };
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEA580C" } };
  });
}

function styleZebraRow(row: ExcelJS.Row) {
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${ZEBRA_FILL.toUpperCase()}` } };
  });
}

/** Fila de total al pie de una hoja de detalle — `values` ya trae el label
 * ("Total") en la columna correspondiente, no es un parámetro aparte. */
function addTotalRow(worksheet: ExcelJS.Worksheet, values: (number | string)[]) {
  const row = worksheet.addRow(values);
  row.font = { bold: true };
  row.eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F0EF" } };
  });
}

async function exportExcel(res: Response, data: ReportData, rangeLabel: string, branchLabel: string) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Mecatos el Santi";
  workbook.created = new Date();

  /* --- Resumen --- */
  const resumen = workbook.addWorksheet("Resumen");
  resumen.columns = [{ width: 34 }, { width: 20 }];

  if (logoBuffer) {
    // `as any`: desajuste de tipos entre el `Buffer` real de Node 24 y el
    // `Buffer` más viejo que esperan los tipos de `exceljs` — el valor en
    // tiempo de ejecución es válido, es puramente un desacuerdo de tipos
    // entre versiones de `@types/node`.
    const imageId = workbook.addImage({ buffer: logoBuffer as any, extension: "png" });
    // `ext` fijo (no proporcional a mano) — el logo recortado ya viene con
    // una relación de aspecto conocida, este tamaño lo respeta sin
    // estirarlo.
    resumen.addImage(imageId, { tl: { col: 0, row: 0 }, ext: { width: 150, height: 44 } });
    resumen.getRow(1).height = 36;
  }
  resumen.addRow([]);

  const titleRow = resumen.addRow(["Reporte financiero — Mecatos el Santi"]);
  titleRow.font = { bold: true, size: 14, color: { argb: "FFEA580C" } };
  resumen.addRow([`Periodo: ${rangeLabel}`]);
  resumen.addRow([`Sede: ${branchLabel}`]);
  resumen.addRow([`Generado: ${formatBogota(new Date())}`]);
  resumen.addRow([]);

  const summaryRows: [string, number][] = [
    ["Total ventas", data.totalSales],
    ["Total compras", data.totalPurchases],
    ["Total gastos", data.totalExpenses],
    ["Valor total de inventario", data.totalInventoryValue],
  ];
  for (const [label, value] of summaryRows) {
    const row = resumen.addRow([label, value]);
    row.getCell(2).numFmt = MONEY_FMT;
  }
  const netRow = resumen.addRow(["Neto (ventas - compras - gastos)", data.net]);
  netRow.font = { bold: true, color: { argb: data.net < 0 ? "FFEF4444" : "FF16A34A" } };
  netRow.getCell(2).numFmt = MONEY_FMT;
  resumen.addRow([]);

  const salesHeaderRow = resumen.addRow(["Ventas por método de pago"]);
  salesHeaderRow.font = { bold: true };
  for (const [method, amount] of Object.entries(data.salesByMethod)) {
    resumen.addRow([method, amount]).getCell(2).numFmt = MONEY_FMT;
  }
  resumen.addRow([]);

  const expHeaderRow = resumen.addRow(["Gastos por categoría"]);
  expHeaderRow.font = { bold: true };
  for (const [cat, amount] of Object.entries(data.expensesByCategory)) {
    resumen.addRow([cat, amount]).getCell(2).numFmt = MONEY_FMT;
  }

  /* --- Inventario --- */
  const inventarioSheet = workbook.addWorksheet("Inventario");
  inventarioSheet.columns = [
    { header: "SKU", key: "sku", width: 12 },
    { header: "Producto", key: "producto", width: 28 },
    { header: "Categoría", key: "categoria", width: 16 },
    { header: "Sede", key: "sede", width: 22 },
    { header: "Precio", key: "precio", width: 14, style: { numFmt: MONEY_FMT } },
    { header: "Cantidad", key: "cantidad", width: 12 },
    { header: "Valor total", key: "valorTotal", width: 16, style: { numFmt: MONEY_FMT } },
  ];
  styleHeaderRow(inventarioSheet.getRow(1));
  inventarioSheet.views = [{ state: "frozen", ySplit: 1 }];
  data.inventory.forEach((i, idx) => {
    const row = inventarioSheet.addRow({
      sku: i.sku,
      producto: i.name,
      categoria: i.category,
      sede: i.branch,
      precio: i.price,
      cantidad: i.quantity,
      valorTotal: i.totalValue,
    });
    if (idx % 2 === 1) styleZebraRow(row);
  });
  if (data.inventory.length > 0) {
    addTotalRow(inventarioSheet, ["", "", "", "", "", "Total", data.totalInventoryValue]);
  }

  /* --- Ventas --- */
  const ventasSheet = workbook.addWorksheet("Ventas");
  ventasSheet.columns = [
    { header: "Fecha", key: "fecha", width: 20 },
    { header: "Sede", key: "sede", width: 26 },
    { header: "Canal", key: "canal", width: 14 },
    { header: "Método de pago", key: "metodo", width: 16 },
    { header: "Categoría", key: "categoria", width: 12 },
    { header: "Total", key: "total", width: 14, style: { numFmt: MONEY_FMT } },
  ];
  styleHeaderRow(ventasSheet.getRow(1));
  ventasSheet.views = [{ state: "frozen", ySplit: 1 }];
  data.sales.forEach((s: any, idx: number) => {
    const row = ventasSheet.addRow({
      fecha: formatBogota(s.createdAt),
      sede: s.branchId?.name || "—",
      canal: s.orderType,
      metodo: s.paymentMethod,
      categoria: s.category,
      total: s.total,
    });
    if (idx % 2 === 1) styleZebraRow(row);
  });
  if (data.sales.length > 0) {
    addTotalRow(ventasSheet, ["", "", "", "", "Total", data.totalSales]);
  }

  /* --- Compras --- */
  const comprasSheet = workbook.addWorksheet("Compras");
  comprasSheet.columns = [
    { header: "Fecha", key: "fecha", width: 20 },
    { header: "Sede", key: "sede", width: 24 },
    { header: "Producto", key: "producto", width: 24 },
    { header: "Cantidad", key: "cantidad", width: 12 },
    { header: "Proveedor", key: "proveedor", width: 24 },
    { header: "Monto", key: "monto", width: 14, style: { numFmt: MONEY_FMT } },
  ];
  styleHeaderRow(comprasSheet.getRow(1));
  comprasSheet.views = [{ state: "frozen", ySplit: 1 }];
  data.purchases.forEach((p: any, idx: number) => {
    const row = comprasSheet.addRow({
      fecha: formatBogota(p.createdAt),
      sede: p.branchId?.name || "—",
      producto: p.productId?.name || p.concept || "—",
      cantidad: p.quantity ?? "—",
      proveedor: p.supplierName,
      monto: p.amount,
    });
    if (idx % 2 === 1) styleZebraRow(row);
  });
  if (data.purchases.length > 0) {
    addTotalRow(comprasSheet, ["", "", "", "", "Total", data.totalPurchases]);
  }

  /* --- Gastos --- */
  const gastosSheet = workbook.addWorksheet("Gastos");
  gastosSheet.columns = [
    { header: "Fecha", key: "fecha", width: 20 },
    { header: "Sede", key: "sede", width: 26 },
    { header: "Categoría", key: "categoria", width: 18 },
    { header: "Concepto", key: "concepto", width: 30 },
    { header: "Monto", key: "monto", width: 14, style: { numFmt: MONEY_FMT } },
  ];
  styleHeaderRow(gastosSheet.getRow(1));
  gastosSheet.views = [{ state: "frozen", ySplit: 1 }];
  data.expenses.forEach((e: any, idx: number) => {
    const row = gastosSheet.addRow({
      fecha: formatBogota(e.createdAt),
      sede: e.branchId?.name || "—",
      categoria: e.category,
      concepto: e.concept,
      monto: e.amount,
    });
    if (idx % 2 === 1) styleZebraRow(row);
  });
  if (data.expenses.length > 0) {
    addTotalRow(gastosSheet, ["", "", "", "Total", data.totalExpenses]);
  }

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="reporte-financiero.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
}

/* -------------------------------- PDF ------------------------------------ */

/**
 * Tabla de detalle con estilo "profesional" — pdfkit no trae tablas
 * propias, así que esto sigue siendo hecho a mano (igual que antes de este
 * rediseño), pero ahora con: barra de título con el color de marca, fila
 * de encabezado con fondo suave, y filas cebra (fondo gris clarito
 * alternado) para poder seguir una fila larga con muchas columnas sin
 * perder la línea — antes era texto plano fila tras fila, sin ningún
 * indicio visual de separación entre una fila y la siguiente.
 *
 * `doc.text()` avanza `doc.y` cada vez que se llama — si cada celda de una
 * fila lo usa como referencia de posición, cada celda siguiente arranca
 * más abajo que la anterior (efecto "escalera"). Por eso acá se fija un
 * `y` único ANTES de dibujar toda la fila, se calcula la altura real de la
 * celda más alta (con `heightOfString`, por si el texto envuelve a más de
 * una línea) y solo al final se avanza `doc.y` esa altura — una sola vez,
 * no una por celda. Este gotcha ya estaba documentado/resuelto antes del
 * rediseño; se preservó tal cual.
 */
function addDetailTable(
  doc: PDFKit.PDFDocument,
  title: string,
  headers: string[],
  widths: number[],
  rows: string[][],
  options?: { caption?: string; totalLabel?: string; totalValue?: string }
) {
  const left = doc.page.margins.left;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const tableWidth = widths.reduce((a, b) => a + b, 0);

  const titleY = doc.y;
  doc.rect(left, titleY, tableWidth, 22).fill(BRAND_COLOR);
  doc.fillColor("#fff").font("Helvetica-Bold").fontSize(12).text(title, left + 10, titleY + 5);
  doc.fillColor("#000");
  doc.y = titleY + 26;

  if (options?.caption) {
    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#888").text(options.caption, left, doc.y, { width: tableWidth });
    doc.fillColor("#000");
    doc.moveDown(0.3);
  }

  const rowHeight = (cells: string[], fontSize: number) =>
    Math.max(...cells.map((c, i) => doc.fontSize(fontSize).heightOfString(c, { width: widths[i] })), fontSize * 1.2);

  const drawRow = (cells: string[], fontSize: number, bold: boolean, fillBg?: string) => {
    const y = doc.y;
    const h = rowHeight(cells, fontSize);
    if (fillBg) {
      doc.rect(left, y - 2, tableWidth, h + 6).fill(fillBg);
    }
    let x = left;
    doc
      .font(bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(fontSize)
      .fillColor("#000");
    cells.forEach((cell, i) => {
      doc.text(cell, x, y, { width: widths[i] });
      x += widths[i];
    });
    doc.y = y + h + 4;
  };

  const drawHeader = () => drawRow(headers, 9, true, BRAND_COLOR_LIGHT);

  drawHeader();

  rows.forEach((row, i) => {
    if (doc.y + rowHeight(row, 8) > bottom) {
      // El encabezado corrido (logo + franja de marca) se redibuja solo
      // vía el listener `pageAdded` (ver `exportPdf`) — acá solo hace
      // falta repetir la fila de columnas de ESTA tabla.
      doc.addPage();
      drawHeader();
    }
    drawRow(row, 8, false, i % 2 === 1 ? `#${ZEBRA_FILL}` : undefined);
  });

  if (rows.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor("#999").text("Sin registros en este rango.");
    doc.fillColor("#000");
  } else if (options?.totalLabel && options?.totalValue) {
    if (doc.y + 22 > bottom) {
      doc.addPage();
      drawHeader();
    }
    const y = doc.y;
    const lastWidth = widths[widths.length - 1];
    doc.rect(left, y - 2, tableWidth, 20).fill("#f0f0ef");
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#000");
    doc.text(options.totalLabel, left + 6, y + 3, { width: tableWidth - lastWidth - 12 });
    doc.text(options.totalValue, left + tableWidth - lastWidth, y + 3, { width: lastWidth - 6, align: "right" });
    doc.y = y + 24;
  }

  doc.moveDown(0.6);
}

/**
 * Caja de KPIs del resumen (Ventas/Compras/Gastos/Inventario/Neto) — mismo
 * lenguaje visual que la fila de tarjetas del Dashboard (punto 54 de
 * CLAUDE.md): fondo suave del color de marca, Neto en verde/rojo según el
 * signo. Reemplaza las líneas de texto plano que tenía el diseño anterior.
 */
function drawSummaryBox(doc: PDFKit.PDFDocument, data: ReportData, width: number) {
  const left = doc.page.margins.left;
  const rows: { label: string; value: number; bold?: boolean; color?: string }[] = [
    { label: "Total ventas", value: data.totalSales },
    { label: "Total compras", value: data.totalPurchases },
    { label: "Total gastos", value: data.totalExpenses },
    { label: "Valor total de inventario", value: data.totalInventoryValue },
    {
      label: "Neto (ventas - compras - gastos)",
      value: data.net,
      bold: true,
      color: data.net < 0 ? RED : GREEN,
    },
  ];

  const rowH = 20;
  const boxHeight = rows.length * rowH + 16;
  const y0 = doc.y;

  doc.roundedRect(left, y0, width, boxHeight, 6).fill(BRAND_COLOR_LIGHT);

  let y = y0 + 10;
  for (const row of rows) {
    doc
      .font(row.bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(10)
      .fillColor(row.color || "#333");
    doc.text(row.label, left + 14, y, { width: width * 0.6 });
    doc.text(money(row.value), left + 14, y, { width: width - 28, align: "right" });
    y += rowH;
  }
  doc.fillColor("#000");
  doc.y = y0 + boxHeight + 16;
}

function exportPdf(res: Response, data: ReportData, rangeLabel: string, branchLabel: string) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="reporte-financiero.pdf"');

  // `autoFirstPage: false` + `doc.addPage()` explícito más abajo: así el
  // listener `pageAdded` (que dibuja el logo + franja de marca) también
  // corre para la PRIMERA página, no solo para las que agrega
  // `addDetailTable` al paginar — con el comportamiento por defecto de
  // pdfkit (que crea la página 1 dentro del constructor, antes de poder
  // engancharse a ningún evento) la portada quedaba sin ese encabezado
  // corrido mientras el resto de páginas sí lo tenían.
  const MARGIN = 40;
  const doc = new PDFDocument({ margin: MARGIN, size: "A4", bufferPages: true, autoFirstPage: false });
  doc.pipe(res);

  // No se puede leer `doc.page.width/margins` todavía acá — con
  // `autoFirstPage: false`, `doc.page` es `null` hasta el primer
  // `addPage()` (más abajo). A4 en pdfkit es 595.28x841.89pt, así que el
  // ancho útil se calcula a mano con la misma constante `MARGIN` de arriba
  // en vez de depender de `doc.page`.
  const A4_WIDTH = 595.28;
  const contentWidth = A4_WIDTH - MARGIN * 2;
  const HEADER_HEIGHT = 55;

  doc.on("pageAdded", () => {
    const left = doc.page.margins.left;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, left, 18, { width: 55 });
      } catch (err) {
        // No debería pasar (el buffer ya se validó al cargar el archivo al
        // inicio del módulo) — si pdfkit igual falla acá, mejor perder el
        // logo de esa página puntual que tumbar todo el reporte.
        console.error("[reportController] No se pudo dibujar el logo en el PDF:", err);
      }
    }
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor("#999")
      .text("Mecatos el Santi — Reporte financiero", left + 70, 26, {
        width: contentWidth - 70,
        align: "right",
      });
    doc.rect(left, HEADER_HEIGHT, contentWidth, 2).fill(BRAND_COLOR);
    doc.fillColor("#000");
    doc.y = HEADER_HEIGHT + 15;
  });

  doc.addPage();

  doc.fontSize(18).font("Helvetica-Bold").fillColor(BRAND_COLOR).text("Reporte financiero");
  doc.fillColor("#000");
  doc.moveDown(0.2);
  doc.fontSize(10).font("Helvetica").fillColor("#555");
  doc.text(`Periodo: ${rangeLabel}`);
  doc.text(`Sede: ${branchLabel}`);
  doc.text(`Generado: ${formatBogota(new Date())}`);
  doc.fillColor("#000");
  doc.moveDown(0.6);

  drawSummaryBox(doc, data, contentWidth);

  addDetailTable(
    doc,
    "Ventas por método de pago",
    ["Método", "Monto"],
    [contentWidth - 140, 140],
    Object.entries(data.salesByMethod).map(([method, amount]) => [method, money(amount)])
  );

  addDetailTable(
    doc,
    "Gastos por categoría",
    ["Categoría", "Monto"],
    [contentWidth - 140, 140],
    Object.entries(data.expensesByCategory).map(([cat, amount]) => [cat, money(amount)])
  );

  doc.addPage();
  addDetailTable(
    doc,
    "Ventas",
    ["Fecha", "Sede", "Canal", "Método", "Categoría", "Total"],
    [95, 110, 65, 65, 60, 80],
    data.sales.map((s: any) => [
      formatBogota(s.createdAt),
      s.branchId?.name || "—",
      s.orderType,
      s.paymentMethod,
      s.category,
      money(s.total),
    ]),
    { totalLabel: "Total ventas", totalValue: money(data.totalSales) }
  );

  doc.addPage();
  addDetailTable(
    doc,
    "Compras",
    ["Fecha", "Sede", "Producto", "Cantidad", "Proveedor", "Monto"],
    [90, 85, 120, 55, 90, 75],
    data.purchases.map((p: any) => [
      formatBogota(p.createdAt),
      p.branchId?.name || "—",
      p.productId?.name || p.concept || "—",
      p.quantity !== undefined && p.quantity !== null ? String(p.quantity) : "—",
      p.supplierName,
      money(p.amount),
    ]),
    { totalLabel: "Total compras", totalValue: money(data.totalPurchases) }
  );

  doc.addPage();
  addDetailTable(
    doc,
    "Gastos",
    ["Fecha", "Sede", "Categoría", "Concepto", "Monto"],
    [95, 110, 90, 130, 90],
    data.expenses.map((e: any) => [
      formatBogota(e.createdAt),
      e.branchId?.name || "—",
      e.category,
      e.concept,
      money(e.amount),
    ]),
    { totalLabel: "Total gastos", totalValue: money(data.totalExpenses) }
  );

  doc.addPage();
  addDetailTable(
    doc,
    "Inventario",
    ["SKU", "Producto", "Categoría", "Sede", "Precio", "Cant.", "Valor total"],
    [55, 120, 70, 85, 65, 45, 75],
    data.inventory.map((i) => [i.sku, i.name, i.category, i.branch, money(i.price), String(i.quantity), money(i.totalValue)]),
    {
      caption: "Inventario actual al momento de generar el reporte — no depende del rango de fechas seleccionado.",
      totalLabel: "Valor total de inventario",
      totalValue: money(data.totalInventoryValue),
    }
  );

  // Pie de página con número de página — solo se puede saber el total de
  // páginas al final (por eso `bufferPages: true` arriba, que mantiene
  // todas las páginas en memoria hasta acá en vez de irlas mandando ya
  // cerradas a la respuesta HTTP). `switchToPage` vuelve a una página ya
  // "terminada" para poder seguir dibujando en ella sin agregar una nueva.
  //
  // Bug real encontrado al verificar el PDF generado: escribir en
  // `y = page.height - margins.bottom + 12` (adentro del margen inferior,
  // a propósito, para que el pie no choque con la última fila de una
  // tabla) queda por debajo de `page.maxY()` (`height - margins.bottom`),
  // el límite que pdfkit usa para decidir si el texto "no cabe" — como
  // `.text()` pagina automáticamente cuando eso pasa, cada llamada de este
  // loop terminaba agregando una página EN BLANCO nueva para "seguir
  // escribiendo ahí", en vez de escribir en el margen de la página actual
  // (el PDF pasó de 5 a 10 páginas, la mitad vacías, con la numeración del
  // pie corrida). La corrección estándar de pdfkit para pies de página:
  // bajar `margins.bottom` a 0 justo antes de escribir (así
  // `page.maxY()` pasa a ser `page.height`, sin límite inferior) y
  // restaurarlo enseguida después — nunca dejarlo en 0 mientras se dibuja
  // contenido real, solo durante este loop.
  const pageRange = doc.bufferedPageRange();
  const realBottomMargin = doc.page.margins.bottom;
  for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
    doc.switchToPage(i);
    const bottomY = doc.page.height - realBottomMargin + 12;
    doc.page.margins.bottom = 0;
    doc
      .fontSize(8)
      .font("Helvetica")
      .fillColor("#aaa")
      .text(`Página ${i + 1} de ${pageRange.count}`, doc.page.margins.left, bottomY, {
        width: contentWidth,
        align: "center",
      });
    doc.page.margins.bottom = realBottomMargin;
  }

  doc.end();
}
