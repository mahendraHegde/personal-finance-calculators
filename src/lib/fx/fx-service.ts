// Live FX rates from a free, no-key endpoint (open.er-api.com), anchored to USD.
// Parsing is split out as a pure function so it's unit-testable without network.
// Rates are cached by the store; manual overrides let the user pin a rate.

import type { CurrencyCode, FxTable } from "../money/currency";

export const FX_ENDPOINT = "https://open.er-api.com/v6/latest/USD";

interface ErApiResponse {
  result?: string;
  base_code?: string;
  rates?: Record<string, number>;
}

/** Pure: turn an open.er-api.com payload into a USD-anchored FxTable. */
export function parseErApi(json: unknown): FxTable {
  const r = json as ErApiResponse;
  if (r.result !== "success" || !r.rates) throw new Error("FX provider returned an error");
  return { base: r.base_code ?? "USD", rates: r.rates };
}

export async function fetchUsdRates(
  fetchImpl: typeof fetch = fetch,
): Promise<FxTable> {
  const res = await fetchImpl(FX_ENDPOINT);
  if (!res.ok) throw new Error(`FX fetch failed: ${res.status}`);
  return parseErApi(await res.json());
}

/** Apply manual rate overrides (units of CCY per 1 base) on top of a table. */
export function withOverrides(fx: FxTable, overrides: Record<CurrencyCode, number>): FxTable {
  const rates = { ...fx.rates };
  for (const [code, rate] of Object.entries(overrides)) {
    if (Number.isFinite(rate) && rate > 0) rates[code] = rate;
  }
  return { base: fx.base, rates };
}
