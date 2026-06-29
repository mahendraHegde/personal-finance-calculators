// Live-price orchestration. Glue between the pluggable price providers
// (lib/prices) and the holding domain: resolve each holding to its provider,
// batch-fetch per provider (tolerating a provider being down), FX-convert each
// quote into the holding's currency, then hand off to the PURE buildValuations()
// to turn prices into valuation events. The store persists the result.
//
// Keeping fetch + FX here (and buildValuations pure) means the unit tests can
// drive the whole pipeline with stub providers and a fixed FxTable.

import type { FxTable } from "../../../lib/money/currency";
import { tryConvert } from "../../../lib/money/currency";
import type { PriceProvider, PriceProviderRegistry } from "../../../lib/prices/types";
import { coinGeckoProvider } from "../../../lib/prices/coingecko";
import { mfApiProvider } from "../../../lib/prices/mfapi";
import { googleFinanceProvider, type GoogleFinanceOracle } from "../../../lib/prices/googlefinance";
import { buildValuations } from "../domain/prices";
import type { Holding, HoldingEvent } from "../model/types";

export interface PriceRunResult {
  valuations: HoldingEvent[];
  skipped: Array<{ holding: Holding; reason: string }>;
}

/** Build the price-provider registry. CoinGecko + mfapi.in are always present
 *  (keyless, CORS-direct). GOOGLEFINANCE is added only when an oracle is supplied
 *  (it needs the user's Drive/Sheets OAuth), so this stays testable and the rest
 *  of the app never depends on Google being configured. */
export function createPriceProviders(
  opts: { fetchImpl?: typeof fetch; googleFinance?: GoogleFinanceOracle } = {},
): PriceProviderRegistry {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const providers: PriceProvider[] = [coinGeckoProvider(fetchImpl), mfApiProvider(fetchImpl)];
  if (opts.googleFinance) providers.push(googleFinanceProvider(opts.googleFinance));
  return new Map(providers.map((p) => [p.id, p]));
}

/**
 * Price every live-priced holding and return the valuation events to persist
 * plus a per-holding list of what was skipped and why (surfaced in the UI).
 * Holdings with no ticker/source are left untouched (not "skipped" — they're
 * simply not configured for live pricing).
 */
export async function fetchPrices(
  holdings: Holding[],
  eventsByHolding: Map<string, HoldingEvent[]>,
  providers: PriceProviderRegistry,
  fx: FxTable,
  date: string,
): Promise<PriceRunResult> {
  const skipped: PriceRunResult["skipped"] = [];
  const priceByHolding = new Map<string, number>();

  // Group configured holdings by their resolved provider.
  const grouped = new Map<string, Holding[]>();
  for (const h of holdings) {
    if (h.archived) continue;
    if (!h.ticker?.trim() || !h.priceSource) continue; // not set up for live pricing
    if (!providers.has(h.priceSource)) {
      skipped.push({ holding: h, reason: `no price provider for "${h.priceSource}"` });
      continue;
    }
    const list = grouped.get(h.priceSource);
    if (list) list.push(h);
    else grouped.set(h.priceSource, [h]);
  }

  // Fetch each provider's batch in parallel; a provider that throws (offline /
  // source down) only costs ITS holdings, not the whole run.
  await Promise.all(
    [...grouped].map(async ([sourceId, hs]) => {
      const provider = providers.get(sourceId)!;
      let quoteByTicker: Map<string, { price: number; currency: string }>;
      try {
        const quotes = await provider.quote(hs.map((h) => ({ ticker: h.ticker!.trim() })));
        quoteByTicker = new Map(quotes.map((q) => [q.ticker, { price: q.price, currency: q.currency }]));
      } catch {
        for (const h of hs) skipped.push({ holding: h, reason: `${provider.label} unavailable` });
        return;
      }
      for (const h of hs) {
        const q = quoteByTicker.get(h.ticker!.trim());
        if (!q) {
          skipped.push({ holding: h, reason: "no quote returned" });
          continue;
        }
        // Never GUESS the currency: GOOGLEFINANCE occasionally returns a price
        // with a blank currency cell, and assuming it's the holding's currency
        // would silently mis-value a foreign-quoted ticker (e.g. a USD price on
        // an INR holding valued ~1/85th). Skip instead — a re-refresh usually
        // resolves the currency.
        if (!q.currency) {
          skipped.push({ holding: h, reason: "couldn't determine the quote's currency — try refreshing again" });
          continue;
        }
        // Convert the source's quote currency into the holding's own currency.
        const inHoldingCcy = tryConvert({ amount: q.price, currency: q.currency }, h.currency, fx);
        if (inHoldingCcy === null) {
          skipped.push({ holding: h, reason: `can't convert ${q.currency} → ${h.currency} (set an FX rate)` });
          continue;
        }
        priceByHolding.set(h.id, inHoldingCcy);
      }
    }),
  );

  // buildValuations applies the units checks (units not tracked / none held /
  // bad price) and emits the valuation events.
  const priced = holdings.filter((h) => priceByHolding.has(h.id));
  const built = buildValuations(priced, eventsByHolding, priceByHolding, date);
  return { valuations: built.valuations, skipped: [...skipped, ...built.skipped] };
}
