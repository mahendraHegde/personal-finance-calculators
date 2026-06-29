// Tests for the live-price layer: the pure source parsers (CoinGecko, mfapi.in),
// the pure buildValuations(), and the fetchPrices() orchestration driven by stub
// providers (no network) — covering FX conversion, per-provider failure
// isolation, and every skip reason.

import { parseCoinGecko } from "../src/lib/prices/coingecko";
import { parseMfApiLatest } from "../src/lib/prices/mfapi";
import { parseSheetQuotes } from "../src/lib/google/sheets-oracle";
import type { PriceProvider, PriceProviderRegistry } from "../src/lib/prices/types";
import { buildValuations } from "../src/features/portfolio/domain/prices";
import { createPriceProviders, fetchPrices } from "../src/features/portfolio/services/price-service";
import type { Holding, HoldingEvent } from "../src/features/portfolio/model/types";
import type { FxTable } from "../src/lib/money/currency";
import { done, eq, near, ok, section } from "./_harness";

const FX: FxTable = { base: "USD", rates: { USD: 1, INR: 80 } };

function holding(over: Partial<Holding>): Holding {
  return {
    id: over.id ?? "h1",
    name: over.name ?? "Test",
    personId: over.personId ?? "p1",
    assetClass: over.assetClass ?? "equity",
    currency: over.currency ?? "USD",
    incomeMode: over.incomeMode ?? "accumulating",
    ...over,
  };
}

function buy(holdingId: string, units: number, price: number): HoldingEvent {
  return { id: `${holdingId}-buy`, holdingId, date: "2025-01-01", type: "buy", units, price };
}

// ---------------------------------------------------------------------------
section("[coingecko] parse simple/price payload");
{
  const quotes = parseCoinGecko({ bitcoin: { usd: 65000 }, ethereum: { usd: 3200 } }, [
    "bitcoin",
    "ethereum",
  ]);
  eq(quotes.length, 2, "two quotes");
  eq(quotes[0].currency, "USD", "quoted in USD");
  near(quotes[0].price, 65000, 0, "btc price");
}

section("[coingecko] unknown / malformed ids are omitted");
{
  const quotes = parseCoinGecko({ bitcoin: { usd: 65000 }, doge: {} }, ["bitcoin", "doge", "nope"]);
  eq(quotes.length, 1, "only the valid quote survives");
  eq(quotes[0].ticker, "bitcoin", "the valid one");
}

section("[mfapi] parse latest NAV");
{
  const q = parseMfApiLatest(
    { status: "SUCCESS", data: [{ date: "27-06-2026", nav: "123.4567" }] },
    "118550",
  );
  ok(q !== null, "got a quote");
  near(q!.price, 123.4567, 0, "NAV parsed");
  eq(q!.currency, "INR", "NAV is INR");
  eq(q!.asOf, "2026-06-27", "DD-MM-YYYY → ISO");
}

section("[mfapi] missing / non-numeric NAV → null");
{
  eq(parseMfApiLatest({ data: [] }, "x"), null, "empty data");
  eq(parseMfApiLatest({ data: [{ nav: "N.A." }] }, "x"), null, "non-numeric");
  eq(parseMfApiLatest({}, "x"), null, "no data key");
}

// ---------------------------------------------------------------------------
section("[buildValuations] units × price → valuation");
{
  const h = holding({ id: "h1", currency: "USD" });
  const events = new Map([["h1", [buy("h1", 10, 100)]]]);
  const prices = new Map([["h1", 150]]);
  const { valuations, skipped } = buildValuations([h], events, prices, "2026-06-28");
  eq(skipped.length, 0, "nothing skipped");
  eq(valuations.length, 1, "one valuation");
  near(valuations[0].amount!, 1500, 0, "10 units × 150");
  eq(valuations[0].type, "valuation", "type valuation");
  eq(valuations[0].note, "auto: live price", "noted as auto");

  // Same-day re-run yields the SAME id → store.put overwrites, no duplicate.
  const again = buildValuations([h], events, prices, "2026-06-28");
  eq(again.valuations[0].id, valuations[0].id, "deterministic per-(holding,day) id");
  ok(valuations[0].id.includes("2026-06-28"), "id carries the date");
}

section("[buildValuations] skip reasons");
{
  const amountOnly = holding({ id: "amt" }); // no unit-tracked events
  const soldOut = holding({ id: "sold" });
  const bad = holding({ id: "bad" });
  const events = new Map<string, HoldingEvent[]>([
    ["amt", [{ id: "e", holdingId: "amt", date: "2025-01-01", type: "opening", amount: 1000 }]],
    [
      "sold",
      [buy("sold", 5, 100), { id: "s", holdingId: "sold", date: "2025-06-01", type: "sell", units: 5 }],
    ],
    ["bad", [buy("bad", 1, 1)]],
  ]);
  const prices = new Map([
    ["amt", 50],
    ["sold", 120],
    ["bad", -3],
  ]);
  const { valuations, skipped } = buildValuations([amountOnly, soldOut, bad], events, prices, "2026-06-28");
  eq(valuations.length, 0, "no valuations");
  const reason = (id: string) => skipped.find((s) => s.holding.id === id)?.reason ?? "";
  ok(reason("amt").includes("units not tracked"), "amount-only → units not tracked");
  ok(reason("sold").includes("no units held"), "sold out → no units held");
  ok(reason("bad").includes("bad price"), "negative price → bad price");
}

// ---------------------------------------------------------------------------
// Stub providers for the orchestration tests.
function stubProvider(id: string, table: Record<string, { price: number; currency: string }>): PriceProvider {
  return {
    id,
    label: id,
    async quote(queries) {
      return queries
        .map((q) => {
          const hit = table[q.ticker];
          return hit ? { ticker: q.ticker, price: hit.price, currency: hit.currency } : null;
        })
        .filter((q): q is NonNullable<typeof q> => q !== null);
    },
  };
}
function throwingProvider(id: string): PriceProvider {
  return {
    id,
    label: id,
    async quote() {
      throw new Error("source down");
    },
  };
}

section("[fetchPrices] groups by provider, FX-converts into holding currency");
{
  const btc = holding({ id: "btc", currency: "INR", assetClass: "crypto", ticker: "bitcoin", priceSource: "coingecko" });
  const fund = holding({ id: "fund", currency: "INR", assetClass: "debt", ticker: "118550", priceSource: "mfapi" });
  const events = new Map([
    ["btc", [buy("btc", 2, 1000000)]],
    ["fund", [buy("fund", 100, 120)]],
  ]);
  const providers: PriceProviderRegistry = new Map([
    ["coingecko", stubProvider("coingecko", { bitcoin: { price: 65000, currency: "USD" } })],
    ["mfapi", stubProvider("mfapi", { "118550": { price: 130, currency: "INR" } })],
  ]);
  const { valuations, skipped } = await fetchPrices([btc, fund], events, providers, FX, "2026-06-28");
  eq(skipped.length, 0, "nothing skipped");
  eq(valuations.length, 2, "two valuations");
  const byHolding = new Map(valuations.map((v) => [v.holdingId, v.amount!]));
  // BTC quoted in USD (65000) → INR at 80 = 5,200,000 × 2 units = 10,400,000.
  near(byHolding.get("btc")!, 10_400_000, 0, "crypto USD→INR then × units");
  // Fund quoted in INR (130) × 100 units = 13,000.
  near(byHolding.get("fund")!, 13_000, 0, "MF INR × units");
}

section("[fetchPrices] untracked source, missing quote, provider down, no ticker");
{
  const unknownSrc = holding({ id: "u", ticker: "X", priceSource: "googlefinance" }); // no provider registered
  const noQuote = holding({ id: "nq", ticker: "missing", priceSource: "coingecko" });
  const down = holding({ id: "d", ticker: "bitcoin", priceSource: "mfapi" });
  const noTicker = holding({ id: "nt", priceSource: "coingecko" }); // ticker absent
  const events = new Map([
    ["nq", [buy("nq", 1, 1)]],
    ["d", [buy("d", 1, 1)]],
  ]);
  const providers: PriceProviderRegistry = new Map([
    ["coingecko", stubProvider("coingecko", {})], // returns nothing
    ["mfapi", throwingProvider("mfapi")],
  ]);
  const { valuations, skipped } = await fetchPrices(
    [unknownSrc, noQuote, down, noTicker],
    events,
    providers,
    FX,
    "2026-06-28",
  );
  eq(valuations.length, 0, "no valuations");
  const reason = (id: string) => skipped.find((s) => s.holding.id === id)?.reason ?? "";
  ok(reason("u").includes("no price provider"), "unknown source skipped");
  ok(reason("nq").includes("no quote"), "missing quote skipped");
  ok(reason("d").length > 0, "provider-down holding skipped");
  eq(skipped.find((s) => s.holding.id === "nt"), undefined, "no-ticker holding is left untouched (not skipped)");
}

section("[fetchPrices] unconvertible quote currency → skipped with hint");
{
  // Quote in GBP, but the FxTable has no GBP rate → can't convert.
  const h = holding({ id: "g", currency: "USD", ticker: "x", priceSource: "coingecko" });
  const events = new Map([["g", [buy("g", 1, 1)]]]);
  const providers: PriceProviderRegistry = new Map([
    ["coingecko", stubProvider("coingecko", { x: { price: 10, currency: "GBP" } })],
  ]);
  const { valuations, skipped } = await fetchPrices([h], events, providers, FX, "2026-06-28");
  eq(valuations.length, 0, "not priced");
  ok(skipped[0]?.reason.includes("convert"), "skip reason mentions conversion");
}

section("[fetchPrices] blank quote currency is SKIPPED, never guessed");
{
  // Google Finance sometimes returns a price with a blank currency cell.
  // Guessing the holding's currency would silently mis-value a foreign-quoted
  // ticker, so we skip rather than produce wrong money.
  const h = holding({ id: "gf", currency: "INR", ticker: "VOO", priceSource: "googlefinance" });
  const events = new Map([["gf", [buy("gf", 3, 1000)]]]);
  const providers: PriceProviderRegistry = new Map([
    ["googlefinance", stubProvider("googlefinance", { VOO: { price: 540, currency: "" } })],
  ]);
  const { valuations, skipped } = await fetchPrices([h], events, providers, FX, "2026-06-28");
  eq(valuations.length, 0, "not valued with a guessed currency");
  ok(skipped[0]?.reason.includes("currency"), "skip reason mentions the currency");
}

// ---------------------------------------------------------------------------
section("[sheets-oracle] parseSheetQuotes maps rows, drops errors/loading");
{
  const tickers = ["VOO", "NSE:INFY", "BAD", "MUTF_IN:X"];
  const rows = [
    ["VOO", 540.12, "USD"],
    ["NSE:INFY", 1850, "INR"],
    ["BAD", "#N/A", ""], // GOOGLEFINANCE error
    ["MUTF_IN:X", "Loading..."], // transient
  ];
  const quotes = parseSheetQuotes(rows, tickers);
  eq(quotes.length, 2, "only the two good rows");
  eq(quotes[0].ticker, "VOO", "ticker by row index");
  eq(quotes[1].currency, "INR", "currency uppercased/kept");
  near(quotes[0].price, 540.12, 0, "price parsed");
}

section("[buildValuations] fully-sold fractional position → no phantom dust valuation");
{
  const h = holding({ id: "f", currency: "USD" });
  const events = new Map<string, HoldingEvent[]>([
    [
      "f",
      [
        { id: "b1", holdingId: "f", date: "2025-01-01", type: "buy", units: 0.1, price: 100 },
        { id: "b2", holdingId: "f", date: "2025-02-01", type: "buy", units: 0.2, price: 100 },
        { id: "s1", holdingId: "f", date: "2026-01-01", type: "sell", units: 0.3 },
      ],
    ],
  ]);
  const { valuations, skipped } = buildValuations([h], events, new Map([["f", 150]]), "2026-06-28");
  eq(valuations.length, 0, "no phantom valuation for a sold-out fractional position");
  ok(skipped[0]?.reason.includes("no units"), "skipped: no units held");
}

section("[buildValuations] rejects price 0 (must not silently zero a holding)");
{
  const h = holding({ id: "z", currency: "USD" });
  const events = new Map([["z", [buy("z", 10, 100)]]]);
  const { valuations, skipped } = buildValuations([h], events, new Map([["z", 0]]), "2026-06-28");
  eq(valuations.length, 0, "no valuation for a 0 price");
  ok(skipped[0]?.reason.includes("bad price"), "skipped as bad price");
}

section("[buildValuations] won't overwrite a manually-edited current value");
{
  const h = holding({ id: "e", currency: "USD" });
  // An existing auto-valuation the user edited (EventForm drops the auto note).
  const edited: HoldingEvent = {
    id: "auto-e-2026-06-28",
    holdingId: "e",
    date: "2026-06-28",
    type: "valuation",
    amount: 999,
    createdAt: "x",
  };
  const events = new Map([["e", [buy("e", 10, 100), edited]]]);
  const { valuations, skipped } = buildValuations([h], events, new Map([["e", 150]]), "2026-06-28");
  eq(valuations.length, 0, "did not regenerate over the manual edit");
  ok(skipped[0]?.reason.includes("edited manually"), "skip reason explains why");
}

section("[buildValuations] DOES overwrite its own prior auto-valuation (same day)");
{
  const h = holding({ id: "a", currency: "USD" });
  const prior: HoldingEvent = {
    id: "auto-a-2026-06-28",
    holdingId: "a",
    date: "2026-06-28",
    type: "valuation",
    amount: 1,
    note: "auto: live price",
    createdAt: "x",
  };
  const events = new Map([["a", [buy("a", 10, 100), prior]]]);
  const { valuations } = buildValuations([h], events, new Map([["a", 150]]), "2026-06-28");
  eq(valuations.length, 1, "regenerates over its own auto mark");
  near(valuations[0].amount!, 1500, 0, "10 × 150");
}

section("[createPriceProviders] Google Finance present only with an oracle");
{
  const without = createPriceProviders();
  ok(!without.has("googlefinance"), "no oracle → no googlefinance provider");
  ok(without.has("coingecko") && without.has("mfapi"), "keyless providers always present");
  const oracle = { quote: async () => [] };
  const withGf = createPriceProviders({ googleFinance: oracle });
  ok(withGf.has("googlefinance"), "oracle → googlefinance registered");
}

done();
