// Saneo defensivo de los ítems de una venta en el momento del POST.
//
// Reglas (ver discusión en el commit "subtotal siempre quantity × price"):
//   1. `quantity` se fuerza a entero >= 0 (no se puede vender 0.5 ni -3).
//   2. `price` y `modifiers[].extraPrice` se fuerzan a número (cualquier
//      valor faltante o de tipo incorrecto cae a 0).
//   3. `subtotal` se RECALCULA como (price + sum(modifiers.extraPrice)) *
//      quantity. Nunca se confía en el subtotal que mande el cliente.
//   4. El `price` congelado en la venta es el del payload (lo que el cashier
//      vio al cobrar) — NO se consulta `Product.price` actual. Esto
//      garantiza que si el admin cambia el precio de un producto mañana,
//      las ventas viejas siguen mostrando el precio histórico correcto.
//
// Por qué este helper existe:
//   - `posController.createSale`, `posController.syncOfflineSales` y
//     `adminController.createSaleAdmin` arman ítems de venta y calculan
//     subtotal de forma parecida pero con bugs sutiles diferentes (uno
//     confiaba en `it.subtotal` del cliente, otro en `it.total`, el admin
//     pisaba con `Product.price` actual). Centralizar acá elimina el drift.
//   - El frontend (`posStore.ts`) sigue calculando `subtotal` localmente
//     para mostrar en pantalla al cashier, pero el backend recalcula
//     siempre como defensa. Si el cliente manda basura, el backend la
//     sanea y la venta se crea con valores válidos (no `null`/`NaN`).
//
// Lo que NO hace este helper:
//   - No consulta la BD (no toca `Product` ni `fiscalSnapshot`). Eso lo
//     hace cada controller por separado, porque el admin panel y el POS
//     resuelven productos con criterios ligeramente distintos.
export interface SanitizedSaleItem {
  productId: unknown;
  name: string;
  quantity: number;
  price: number; // precio unitario final (base + modificadores), congelado
  modifiers: { name: string; extraPrice: number }[];
  subtotal: number; // SIEMPRE price * quantity
}

function safeNumber(value: unknown, fallback = 0): number {
  // Acepta number, string numérica ("3500", "3500.5"). Rechaza objetos,
  // arrays, booleanos, NaN, Infinity → fallback.
  if (value === undefined || value === null) return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function safeInteger(value: unknown, fallback = 0): number {
  // Como safeNumber pero forzado a entero no-negativo. La venta no admite
  // fracciones de unidad ni cantidades negativas — si el payload trae algo
  // raro, se redondea hacia abajo a 0.
  const n = safeNumber(value, fallback);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export function sanitizeSaleItems(rawItems: unknown): SanitizedSaleItem[] {
  if (!Array.isArray(rawItems)) return [];
  return rawItems.map((raw: any) => {
    const quantity = safeInteger(raw?.quantity);
    const basePrice = safeNumber(raw?.price);
    const modifiers = Array.isArray(raw?.modifiers)
      ? raw.modifiers.map((m: any) => ({
          name: String(m?.name ?? ""),
          extraPrice: safeNumber(m?.extraPrice),
        }))
      : [];
    const modifiersTotal = modifiers.reduce(
      (acc: number, m: { name: string; extraPrice: number }) => acc + m.extraPrice,
      0
    );
    // Precio unitario final = base + modificadores. Esto es lo que el
    // cliente pagó por UNA unidad; es el que se guarda en `SaleItem.price`
    // (mismo criterio que ya usa `posStore.ts` en el frontend).
    const unitPrice = basePrice + modifiersTotal;
    return {
      productId: raw?.productId,
      name: String(raw?.name ?? "Producto"),
      quantity,
      price: unitPrice,
      modifiers,
      subtotal: unitPrice * quantity,
    };
  });
}
