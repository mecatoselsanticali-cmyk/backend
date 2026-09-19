import "dotenv/config";
import { Types } from "mongoose";
import { getSiigoAccessToken, buildSiigoInvoicePayload } from "../services/dianService";

/**
 * Prueba de conectividad con Siigo SIN crear ninguna factura real.
 *
 * A propósito se detiene antes de `POST /v1/invoices`: la cuenta detrás de
 * SIIGO_USERNAME/SIIGO_ACCESS_KEY es la cuenta de PRODUCCIÓN real del
 * negocio (Partner-Id MecatosElSanti), así que cualquier factura creada ahí
 * queda timbrada de verdad ante la DIAN. Esto solo verifica:
 *   1. Que `getSiigoAccessToken()` autentica correctamente (POST /auth es
 *      un login, sin efectos secundarios).
 *   2. Los catálogos reales de la cuenta (tipos de documento, formas de
 *      pago, vendedores) vía GETs de solo lectura — para reemplazar los
 *      valores de ejemplo de `siigo_test` por ids verificados.
 *   3. Que `buildSiigoInvoicePayload` arma el JSON esperado por Siigo a
 *      partir de una Sale/Product de mentira, sin tocar la red para eso.
 *
 * Uso: npm run test:siigo
 */

const SIIGO_API_URL = "https://api.siigo.com";

async function siigoGet(path: string, token: string) {
  const response = await fetch(`${SIIGO_API_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Partner-Id": process.env.SIIGO_PARTNER_ID || "",
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`${path} respondió ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<any>;
}

async function main() {
  console.log("[testSiigo] 1. Autenticando contra Siigo...");
  const token = await getSiigoAccessToken();
  console.log(`[testSiigo]    OK — token recibido (${token.slice(0, 12)}...)`);

  console.log("[testSiigo] 2. Consultando catálogos reales de la cuenta...");
  const [documentTypes, paymentTypes, users] = await Promise.all([
    siigoGet("/v1/document-types?type=FV", token),
    siigoGet("/v1/payment-types?document_type=FV", token),
    siigoGet("/v1/users?page=1&page_size=100", token),
  ]);

  console.log("\n--- Tipos de documento FV electrónicos (Branch.dianConfig.siigoDocumentId) ---");
  const electronicDocs = (documentTypes as any[]).filter((d) => d.electronic_type === "ElectronicInvoice");
  console.log(JSON.stringify(electronicDocs, null, 2));

  console.log("\n--- Formas de pago (FV) — usar para SIIGO_PAYMENT_ID_<METODO> ---");
  console.log(JSON.stringify(paymentTypes, null, 2));

  console.log("\n--- Usuarios/vendedores, uno por sede (Branch.dianConfig.siigoSellerId) ---");
  console.log(JSON.stringify(users.results, null, 2));

  console.log("\n[testSiigo] 3. Armando un payload de factura de ejemplo (sin enviarlo)...");

  const fakeProductId = new Types.ObjectId();
  const fakeSale = {
    _id: new Types.ObjectId(),
    items: [
      {
        productId: fakeProductId,
        name: "Producto de prueba",
        quantity: 1,
        price: 2500,
        subtotal: 2500,
      },
    ],
    paymentMethod: "CASH" as const,
    total: 2500,
    customer: undefined,
  };
  const fakeProducts = [{ _id: fakeProductId, siigoCode: "cpfma01" }];

  // `branch.dianConfig` de mentira solo para esta demo del payload — no
  // toca ninguna Branch real en Mongo. Usa el primer tipo de documento
  // realmente electrónico (no cualquiera de la lista completa, que incluye
  // "Documento de ingreso" internos sin timbrado DIAN) y el primer vendedor
  // encontrado, solo para mostrar la forma del payload.
  const fakeDianConfig = {
    siigoDocumentId: electronicDocs[0]?.id,
    siigoSellerId: users.results?.[0]?.id,
  };
  const cashPaymentId = (paymentTypes as any[]).find((p) => p.name === "Efectivo")?.id;
  process.env.SIIGO_PAYMENT_ID_CASH = process.env.SIIGO_PAYMENT_ID_CASH || String(cashPaymentId ?? "");

  const built = buildSiigoInvoicePayload(fakeSale as any, fakeProducts as any, fakeDianConfig);
  if ("error" in built) {
    console.log(`[testSiigo]    Error esperable si aún no hay ids configurados: ${built.error}`);
  } else {
    console.log("[testSiigo]    Payload construido (NO enviado a Siigo):");
    console.log(JSON.stringify(built.payload, null, 2));
  }

  console.log("\n[testSiigo] Listo. Ninguna factura fue creada ni enviada a Siigo/DIAN.");
}

main().catch((err) => {
  console.error("[testSiigo] Error:", err.message || err);
  process.exit(1);
});
