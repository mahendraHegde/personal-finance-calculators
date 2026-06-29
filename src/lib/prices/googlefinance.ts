// Google Finance price provider. The actual Sheet plumbing lives in
// lib/google/sheets-oracle (browser-only); this adapter just maps the generic
// PriceProvider interface onto an injected oracle, so lib/prices stays free of
// any Google dependency. Works for equities/ETFs (e.g. "VOO", "NSE:INFY") AND
// mutual funds ("MUTF_IN:..."), since GOOGLEFINANCE is ticker-agnostic — the
// oracle quotes whatever symbol it's given.

import type { PriceProvider, PriceQuery, PriceQuote } from "./types";

/** Anything that can resolve GOOGLEFINANCE tickers to quotes (its native
 *  currency). Implemented by lib/google/SheetsOracle. */
export interface GoogleFinanceOracle {
  quote(tickers: string[]): Promise<Array<{ ticker: string; price: number; currency: string }>>;
}

export function googleFinanceProvider(oracle: GoogleFinanceOracle): PriceProvider {
  return {
    id: "googlefinance",
    label: "Google Finance (Sheet)",
    async quote(queries: PriceQuery[]): Promise<PriceQuote[]> {
      const tickers = [...new Set(queries.map((q) => q.ticker.trim()).filter(Boolean))];
      if (tickers.length === 0) return [];
      const quotes = await oracle.quote(tickers);
      return quotes.map((q) => ({ ticker: q.ticker, price: q.price, currency: q.currency }));
    },
  };
}
