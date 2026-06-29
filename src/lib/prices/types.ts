// Pluggable live-price layer. Same spirit as StorageAdapter: a tiny interface
// with swappable implementations, so adding/removing a quote source (CoinGecko,
// mfapi.in, a GOOGLEFINANCE Sheet, a bring-your-own-key feed) never touches the
// rest of the app. Each provider owns ONE source; a registry maps a source id to
// its provider. Providers quote in whatever currency the source natively returns
// (the caller FX-converts into the holding's currency), and batch where the
// source allows it.

import type { CurrencyCode } from "../money/currency";

/** A request for one instrument's price. `ticker` is provider-namespaced:
 *  a CoinGecko id ("bitcoin"), an mfapi scheme code ("118550"), or a
 *  GOOGLEFINANCE symbol ("NSE:INFY" / "VOO"). */
export interface PriceQuery {
  ticker: string;
}

/** A resolved price, in the currency the SOURCE returned it in. */
export interface PriceQuote {
  ticker: string;
  price: number;
  currency: CurrencyCode;
  /** ISO date the quote is as-of, when the source reports it. */
  asOf?: string;
}

export interface PriceProvider {
  /** Stable id; matches a holding's `priceSource`. */
  readonly id: string;
  /** Human label for UI / skip messages. */
  readonly label: string;
  /**
   * Fetch quotes for a batch of tickers. Implementations should be resilient to
   * a single bad ticker (omit it from the result rather than throwing) but MAY
   * throw if the whole source is unreachable — the caller treats a throw as
   * "this provider's holdings are unpriced this run" and keeps the others.
   */
  quote(queries: PriceQuery[]): Promise<PriceQuote[]>;
}

/** A set of providers keyed by their id (== a holding's `priceSource`). */
export type PriceProviderRegistry = Map<string, PriceProvider>;
