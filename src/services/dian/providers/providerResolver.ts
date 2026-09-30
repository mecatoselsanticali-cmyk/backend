import type {
  ElectronicInvoiceProvider,
  ElectronicInvoiceProviderType,
} from "../../../types/electronicInvoice";

const providerRegistry = new Map<ElectronicInvoiceProviderType, ElectronicInvoiceProvider>();

/**
 * Selección de proveedor con compatibilidad temporal para `DIAN_PROVIDER`.
 * La variable nueva tiene prioridad; sin ninguna, conserva el fallback MOCK.
 */
export function resolveConfiguredInvoiceProvider(): ElectronicInvoiceProviderType {
  const configured = (
    process.env.ELECTRONIC_INVOICE_PROVIDER || process.env.DIAN_PROVIDER || "MOCK"
  )
    .trim()
    .toUpperCase();

  if (configured === "MOCK" || configured === "SIIGO" || configured === "FACTUS") {
    return configured;
  }

  throw new Error(
    "ELECTRONIC_INVOICE_PROVIDER debe ser MOCK, SIIGO o FACTUS (también se acepta DIAN_PROVIDER temporalmente)"
  );
}

/** Registra una instancia concreta de proveedor durante la inicialización. */
export function registerInvoiceProvider(
  providerName: ElectronicInvoiceProviderType,
  provider: ElectronicInvoiceProvider
): void {
  const registeredProvider = providerRegistry.get(providerName);

  if (registeredProvider && registeredProvider !== provider) {
    throw new Error(`El proveedor de factura electrónica '${providerName}' ya está registrado`);
  }

  providerRegistry.set(providerName, provider);
}

/** Resuelve únicamente proveedores registrados; nunca elige un fallback silencioso. */
export function getInvoiceProvider(
  providerName: ElectronicInvoiceProviderType
): ElectronicInvoiceProvider {
  const provider = providerRegistry.get(providerName);

  if (!provider) {
    throw new Error(`El proveedor de factura electrónica '${providerName}' no está registrado`);
  }

  return provider;
}
