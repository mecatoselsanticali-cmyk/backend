require("ts-node/register");

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { Types } = require("mongoose");

const { Sale } = require("../src/models/Sale");
const { Product } = require("../src/models/Product");
const { buildFactusInvoicePayload, FACTUS_PAYMENT_MAP } = require("../src/services/dian/providers/FactusInvoiceMapper");
const { FactusInvoiceProvider } = require("../src/services/dian/providers/FactusInvoiceProvider");
const { getInvoiceProvider, resolveConfiguredInvoiceProvider } = require("../src/services/dian/providers/providerResolver");
const { buildSiigoInvoicePayload } = require("../src/services/dianService");
const { buildSaleItemFiscalSnapshot } = require("../src/utils/fiscalSnapshot");
const { isFinalDianAttempt } = require("../src/utils/dianRetryPolicy");
const { dianService } = require("../src/services/dianService");

async function withEnv(values, callback) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function makeSale(overrides = {}) {
  const productId = new Types.ObjectId();
  const sale = {
    _id: new Types.ObjectId(),
    branchId: new Types.ObjectId(),
    items: [
      {
        productId,
        name: "Empanada",
        quantity: 1,
        price: 2500,
        subtotal: 3000,
        modifiers: [{ name: "Extra queso", extraPrice: 500 }],
        fiscalSnapshot: {
          codeReference: "EMP-001",
          unitMeasureCode: "94",
          standardCode: "999",
          isTaxExcluded: true,
        },
      },
    ],
    paymentMethod: "EFECTIVO",
    total: 3000,
    customer: {
      name: "Ana Pérez",
      document: "12345678",
      email: "ana@example.test",
      identificationDocumentCode: "13",
      legalOrganizationCode: "2",
    },
    ...overrides,
  };
  return { sale, productId };
}

test("provider configuration, registry and per-sale MOCK lock", async () => {
  await withEnv(
    { ELECTRONIC_INVOICE_PROVIDER: "FACTUS", DIAN_PROVIDER: "MOCK" },
    async () => assert.equal(resolveConfiguredInvoiceProvider(), "FACTUS")
  );
  await withEnv(
    { ELECTRONIC_INVOICE_PROVIDER: undefined, DIAN_PROVIDER: "SIIGO" },
    async () => assert.equal(resolveConfiguredInvoiceProvider(), "SIIGO")
  );
  await withEnv(
    { ELECTRONIC_INVOICE_PROVIDER: undefined, DIAN_PROVIDER: undefined },
    async () => assert.equal(resolveConfiguredInvoiceProvider(), "MOCK")
  );

  assert.equal(typeof getInvoiceProvider("MOCK").issueInvoice, "function");
  assert.equal(typeof getInvoiceProvider("SIIGO").issueInvoice, "function");
  assert.equal(typeof getInvoiceProvider("FACTUS").issueInvoice, "function");

  await withEnv({ ELECTRONIC_INVOICE_PROVIDER: "MOCK", DIAN_PROVIDER: "FACTUS" }, async () => {
    const sale = {
      _id: "mock-lock-test",
      total: 1000,
      save: async () => undefined,
    };
    const result = await dianService.emit(sale);
    assert.equal(sale.electronicInvoice.provider, "MOCK");
    assert.equal(sale.electronicInvoice.attempts, 1);
    assert.ok(sale.electronicInvoice.lastAttemptAt instanceof Date);
    assert.ok(["APPROVED", "REJECTED"].includes(result.status));

    // Un cambio posterior de ambiente no reemplaza el provider ya bloqueado.
    process.env.ELECTRONIC_INVOICE_PROVIDER = "FACTUS";
    const retry = await dianService.emit(sale);
    assert.equal(sale.electronicInvoice.provider, "MOCK");
    assert.equal(sale.electronicInvoice.attempts, 2);
    assert.ok(["APPROVED", "REJECTED"].includes(retry.status));
  });
});

test("Factus mapper uses invoice codes, approved payment aliases and fiscal snapshot", () => {
  const { sale, productId } = makeSale();
  const built = buildFactusInvoicePayload(sale, [], { numberingRangeId: 321 });
  assert.ok("payload" in built);
  if (!("payload" in built)) return;

  assert.equal(built.payload.reference_code, `SALE-${sale._id}`);
  assert.equal(built.payload.numbering_range_id, 321);
  assert.equal(built.payload.payment_details[0].payment_form, "1");
  assert.equal(built.payload.payment_details[0].payment_method_code, "10");
  assert.equal(built.payload.items[0].code_reference, "EMP-001");
  assert.equal(built.payload.items[0].name, "Empanada (Extra queso)");
  assert.equal(built.payload.items[0].price, "3000.00");
  assert.deepEqual(built.payload.items[0].taxes, [{ is_excluded: true }]);
  assert.equal(built.payload.establishment, undefined);
  assert.notEqual(String(productId), "");

  assert.deepEqual(FACTUS_PAYMENT_MAP, {
    CASH: "10",
    EFECTIVO: "10",
    NEQUI: "47",
    CARD: "49",
    DELIVERY_APP: "47",
    BANCOLOMBIA: "47",
  });

  const nitSale = {
    ...sale,
    customer: {
      name: "Empresa Ejemplo",
      document: "900.123.456-7",
      identificationDocumentCode: "31",
      legalOrganizationCode: "1",
    },
  };
  const nitPayload = buildFactusInvoicePayload(nitSale, []);
  assert.ok("payload" in nitPayload);
  if ("payload" in nitPayload) {
    assert.equal(nitPayload.payload.customer.identification, "900123456");
    assert.equal(nitPayload.payload.customer.dv, "7");
    assert.equal(nitPayload.payload.customer.company, "Empresa Ejemplo");
  }
});

test("Factus refreshes an invalid token, respects 429 Retry-After, and recovers duplicate references", async () => {
  await withEnv(
    {
      FACTUS_ENV: "sandbox",
      FACTUS_CLIENT_ID: "test-client",
      FACTUS_CLIENT_SECRET: "test-secret",
      FACTUS_USERNAME: "test-user",
      FACTUS_PASSWORD: "test-password",
      FACTUS_NUMBERING_RANGE_ID: undefined,
      FACTUS_SEND_EMAIL: undefined,
    },
    async () => {
      const { sale } = makeSale();
      const secondSale = { ...sale, _id: new Types.ObjectId() };
      const thirdSale = { ...sale, _id: new Types.ObjectId() };
      const requests = [];
      let invoicePosts = 0;
      let authGrants = [];
      const originalFetch = global.fetch;

      global.fetch = async (input, init = {}) => {
        const url = String(input);
        requests.push({ url, init });

        if (url.endsWith("/oauth/token")) {
          const grant = new URLSearchParams(String(init.body)).get("grant_type");
          authGrants.push(grant);
          if (grant === "password") {
            return new Response(JSON.stringify({ access_token: "expired-access", refresh_token: "refresh-1", expires_in: 600 }), { status: 200 });
          }
          return new Response(JSON.stringify({ access_token: "fresh-access", refresh_token: "refresh-2", expires_in: 600 }), { status: 200 });
        }

        if (url.endsWith("/v2/bills/validate")) {
          invoicePosts++;
          const payload = JSON.parse(String(init.body));
          if (invoicePosts === 1) {
            assert.equal(init.headers.Authorization, "Bearer expired-access");
            return new Response(JSON.stringify({ message: "expired" }), { status: 401 });
          }
          if (invoicePosts === 2) {
            assert.equal(init.headers.Authorization, "Bearer fresh-access");
            return new Response(JSON.stringify({ message: "rate limited" }), { status: 429, headers: { "Retry-After": "0" } });
          }
          if (invoicePosts === 3) {
            return new Response(JSON.stringify({ data: {
              reference_code: payload.reference_code,
              number: "FV-0001",
              is_validated: true,
              cufe: "TEST-CUFE",
              links: { qr: "https://example.test/qr" },
            } }), { status: 201 });
          }
          return new Response(JSON.stringify({ message: "duplicate reference_code" }), { status: 422 });
        }

        if (url.includes("/v2/bills?filter%5Breference_code%5D=")) {
          const referenceCode = new URL(url).searchParams.get("filter[reference_code]");
          return new Response(JSON.stringify({ data: { data: [{
            reference_code: referenceCode,
            number: "FV-0001",
            is_validated: true,
            cufe: "TEST-CUFE",
            links: { qr: "https://example.test/qr" },
          }] } }), { status: 200 });
        }

        throw new Error(`Unexpected mocked request ${url}`);
      };

      try {
        const provider = new FactusInvoiceProvider();
        const first = await provider.issueInvoice(sale);
        assert.equal(first.status, "APPROVED");
        assert.equal(first.cufe, "TEST-CUFE");
        assert.deepEqual(authGrants, ["password", "refresh_token"]);

        const recovered = await provider.issueInvoice(secondSale);
        assert.equal(recovered.status, "APPROVED");
        assert.equal(recovered.referenceCode, `SALE-${secondSale._id}`);

        // El tercer POST simula un timeout incierto; no se convierte en
        // REJECTED porque Factus pudo haber creado la factura antes del corte.
        const originalCall = global.fetch;
        global.fetch = async (input, init = {}) => {
          const url = String(input);
          if (url.endsWith("/v2/bills/validate")) throw new Error("simulated socket timeout");
          return originalCall(input, init);
        };
        const uncertain = await provider.issueInvoice(thirdSale);
        assert.equal(uncertain.status, "PENDING");
        assert.equal(uncertain.providerStatus, "REQUEST_OUTCOME_UNKNOWN");
        assert.equal(uncertain.referenceCode, `SALE-${thirdSale._id}`);
      } finally {
        global.fetch = originalFetch;
      }
      assert.ok(requests.every(({ url }) => url.startsWith("https://api-sandbox.factus.com.co/")));
    }
  );
});

test("Product fiscal defaults and legacy Sale documents remain compatible", () => {
  const product = new Product({ name: "Empanada", sku: "EMP-001", category: "FRITANGA", price: 2500 });
  assert.equal(product.unitMeasureCode, "94");
  assert.equal(product.standardCode, "999");
  assert.equal(product.isTaxExcluded, true);

  const fiscalSnapshot = buildSaleItemFiscalSnapshot(product);
  assert.deepEqual(fiscalSnapshot, {
    codeReference: "EMP-001",
    unitMeasureCode: "94",
    standardCode: "999",
    isTaxExcluded: true,
    taxCode: undefined,
    taxRate: undefined,
  });

  const legacySale = new Sale({
    items: [{ productId: new Types.ObjectId(), name: "Vieja", quantity: 1, price: 100, subtotal: 100 }],
  });
  assert.equal(legacySale.electronicInvoice, undefined);
  assert.equal(legacySale.items[0].fiscalSnapshot, undefined);
});

test("a rejected async sale changes to REGULAR only on the final BullMQ attempt", () => {
  assert.equal(isFinalDianAttempt(0, 5), false);
  assert.equal(isFinalDianAttempt(3, 5), false);
  assert.equal(isFinalDianAttempt(4, 5), true);
  assert.equal(isFinalDianAttempt(0, undefined), true);
});
