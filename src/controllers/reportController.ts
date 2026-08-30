import { Request, Response } from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { Sale } from "../models/Sale";
import { Purchase } from "../models/Purchase";
import { Expense } from "../models/Expense";
import { Branch } from "../models/Branch";
import { resolveBranchFilter } from "./adminController";
import { startOfLocalDay, endOfLocalDay, COLOMBIA_TIME_ZONE } from "../utils/dateRange";

/**
 * Reportes financieros (Finanzas > Reportes): resumen + detalle de
 * ventas/compras/gastos en un rango de fechas, exportable a Excel o PDF —
 * ambos generados en el backend (`exceljs`/`pdfkit`), no en el navegador.
 * Un GERENTE solo ve datos de su propia sede (resolveBranchFilter, igual
 * que el resto del panel admin).
 */

interface ReportData {
  sales: any[];
  purchases: any[];
  expenses: any[];
  totalSales: number;
  totalPurchases: number;
  totalExpenses: number;
  net: number;
  salesByMethod: Record<string, number>;
  expensesByCategory: Record<string, number>;
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

  const [sales, purchases, expenses] = await Promise.all([
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
  ]);

  const totalSales = sales.reduce((sum, s: any) => sum + s.total, 0);
  const totalPurchases = purchases.reduce((sum, p: any) => sum + p.amount, 0);
  const totalExpenses = expenses.reduce((sum, e: any) => sum + e.amount, 0);

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
    totalSales,
    totalPurchases,
    totalExpenses,
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

async function exportExcel(res: Response, data: ReportData, rangeLabel: string, branchLabel: string) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Mecatos el Santi";
  workbook.created = new Date();

  const resumen = workbook.addWorksheet("Resumen");
  resumen.columns = [{ width: 34 }, { width: 20 }];
  resumen.addRow(["Reporte financiero — Mecatos el Santi"]).font = { bold: true, size: 14 };
  resumen.addRow([`Periodo: ${rangeLabel}`]);
  resumen.addRow([`Sede: ${branchLabel}`]);
  resumen.addRow([`Generado: ${formatBogota(new Date())}`]);
  resumen.addRow([]);
  resumen.addRow(["Total ventas", data.totalSales]);
  resumen.addRow(["Total compras", data.totalPurchases]);
  resumen.addRow(["Total gastos", data.totalExpenses]);
  const netRow = resumen.addRow(["Neto (ventas - compras - gastos)", data.net]);
  netRow.font = { bold: true };
  resumen.addRow([]);
  const salesHeaderRow = resumen.addRow(["Ventas por método de pago"]);
  salesHeaderRow.font = { bold: true };
  for (const [method, amount] of Object.entries(data.salesByMethod)) resumen.addRow([method, amount]);
  resumen.addRow([]);
  const expHeaderRow = resumen.addRow(["Gastos por categoría"]);
  expHeaderRow.font = { bold: true };
  for (const [cat, amount] of Object.entries(data.expensesByCategory)) resumen.addRow([cat, amount]);

  const ventasSheet = workbook.addWorksheet("Ventas");
  ventasSheet.columns = [
    { header: "Fecha", key: "fecha", width: 20 },
    { header: "Sede", key: "sede", width: 26 },
    { header: "Canal", key: "canal", width: 14 },
    { header: "Método de pago", key: "metodo", width: 16 },
    { header: "Categoría", key: "categoria", width: 12 },
    { header: "Total", key: "total", width: 14 },
  ];
  ventasSheet.getRow(1).font = { bold: true };
  for (const s of data.sales) {
    ventasSheet.addRow({
      fecha: formatBogota(s.createdAt),
      sede: s.branchId?.name || "—",
      canal: s.orderType,
      metodo: s.paymentMethod,
      categoria: s.category,
      total: s.total,
    });
  }

  const comprasSheet = workbook.addWorksheet("Compras");
  comprasSheet.columns = [
    { header: "Fecha", key: "fecha", width: 20 },
    { header: "Sede", key: "sede", width: 26 },
    { header: "Proveedor", key: "proveedor", width: 26 },
    { header: "Concepto", key: "concepto", width: 30 },
    { header: "Producto", key: "producto", width: 22 },
    { header: "Monto", key: "monto", width: 14 },
  ];
  comprasSheet.getRow(1).font = { bold: true };
  for (const p of data.purchases) {
    comprasSheet.addRow({
      fecha: formatBogota(p.createdAt),
      sede: p.branchId?.name || "—",
      proveedor: p.supplierName,
      concepto: p.concept,
      producto: p.productId?.name || "—",
      monto: p.amount,
    });
  }

  const gastosSheet = workbook.addWorksheet("Gastos");
  gastosSheet.columns = [
    { header: "Fecha", key: "fecha", width: 20 },
    { header: "Sede", key: "sede", width: 26 },
    { header: "Categoría", key: "categoria", width: 18 },
    { header: "Concepto", key: "concepto", width: 30 },
    { header: "Monto", key: "monto", width: 14 },
  ];
  gastosSheet.getRow(1).font = { bold: true };
  for (const e of data.expenses) {
    gastosSheet.addRow({
      fecha: formatBogota(e.createdAt),
      sede: e.branchId?.name || "—",
      categoria: e.category,
      concepto: e.concept,
      monto: e.amount,
    });
  }

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", 'attachment; filename="reporte-financiero.xlsx"');
  await workbook.xlsx.write(res);
  res.end();
}

/** Fila simple de texto en columnas de ancho fijo — pdfkit no trae tablas. */
function addDetailTable(
  doc: PDFKit.PDFDocument,
  title: string,
  headers: string[],
  widths: number[],
  rows: string[][]
) {
  const left = doc.page.margins.left;
  const bottom = doc.page.height - doc.page.margins.bottom;

  doc.fontSize(13).font("Helvetica-Bold").text(title);
  doc.moveDown(0.3);

  // `doc.text()` avanza `doc.y` cada vez que se llama — si cada celda de
  // una fila lo usa como referencia de posición, cada celda siguiente
  // arranca más abajo que la anterior (efecto "escalera"). Por eso acá se
  // fija un `y` único ANTES de dibujar toda la fila, se calcula la altura
  // real de la celda más alta (con `heightOfString`, por si el texto
  // envuelve a más de una línea) y solo al final se avanza `doc.y` esa
  // altura — una sola vez, no una por celda.
  const rowHeight = (cells: string[], fontSize: number) =>
    Math.max(
      ...cells.map((c, i) => doc.fontSize(fontSize).heightOfString(c, { width: widths[i] })),
      fontSize * 1.2
    );

  const drawRow = (cells: string[], fontSize: number, bold: boolean) => {
    const y = doc.y;
    let x = left;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
    cells.forEach((cell, i) => {
      doc.text(cell, x, y, { width: widths[i] });
      x += widths[i];
    });
    doc.y = y + rowHeight(cells, fontSize) + 4;
  };

  const drawHeader = () => drawRow(headers, 9, true);

  drawHeader();

  for (const row of rows) {
    if (doc.y + rowHeight(row, 8) > bottom) {
      doc.addPage();
      drawHeader();
    }
    drawRow(row, 8, false);
  }

  if (rows.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor("#999").text("Sin registros en este rango.");
    doc.fillColor("#000");
  }
}

function exportPdf(res: Response, data: ReportData, rangeLabel: string, branchLabel: string) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="reporte-financiero.pdf"');

  const doc = new PDFDocument({ margin: 40, size: "A4" });
  doc.pipe(res);

  doc.fontSize(16).font("Helvetica-Bold").text("Reporte financiero — Mecatos el Santi", { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(10).font("Helvetica").fillColor("#555");
  doc.text(`Periodo: ${rangeLabel}`);
  doc.text(`Sede: ${branchLabel}`);
  doc.text(`Generado: ${formatBogota(new Date())}`);
  doc.fillColor("#000");
  doc.moveDown();

  doc.fontSize(13).font("Helvetica-Bold").text("Resumen");
  doc.fontSize(10).font("Helvetica");
  doc.text(`Total ventas: ${money(data.totalSales)}`);
  doc.text(`Total compras: ${money(data.totalPurchases)}`);
  doc.text(`Total gastos: ${money(data.totalExpenses)}`);
  doc.font("Helvetica-Bold").text(`Neto: ${money(data.net)}`);
  doc.font("Helvetica");
  doc.moveDown(0.5);

  doc.fontSize(11).font("Helvetica-Bold").text("Ventas por método de pago");
  doc.fontSize(9).font("Helvetica");
  for (const [method, amount] of Object.entries(data.salesByMethod)) doc.text(`${method}: ${money(amount)}`);
  doc.moveDown(0.5);

  doc.fontSize(11).font("Helvetica-Bold").text("Gastos por categoría");
  doc.fontSize(9).font("Helvetica");
  for (const [cat, amount] of Object.entries(data.expensesByCategory)) doc.text(`${cat}: ${money(amount)}`);

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
    ])
  );

  doc.addPage();
  addDetailTable(
    doc,
    "Compras",
    ["Fecha", "Sede", "Proveedor", "Producto", "Monto"],
    [95, 110, 110, 110, 90],
    data.purchases.map((p: any) => [
      formatBogota(p.createdAt),
      p.branchId?.name || "—",
      p.supplierName,
      p.productId?.name || "—",
      money(p.amount),
    ])
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
    ])
  );

  doc.end();
}
