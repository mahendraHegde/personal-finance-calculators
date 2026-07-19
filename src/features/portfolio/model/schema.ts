// Storage schema: collection names + the secondary indexes that back our
// paginated/filtered reads. Bumping `version` triggers the IndexedDB upgrade.

import type { StorageSchema } from "../../../lib/storage/types";

export const DB_NAME = "portfolio";

export const Collections = {
  people: "people",
  accounts: "accounts",
  categories: "categories",
  transactions: "transactions",
  holdings: "holdings",
  holdingEvents: "holdingEvents",
  fxRates: "fxRates",
  settings: "settings",
  // Device-local only: a short log of CSV imports so each can be undone. Stripped from
  // backups AND Drive sync (see store.stripLocal) — ephemeral, no long-term value.
  importBatches: "importBatches",
} as const;

// NO secondary indexes: the store loads each collection fully into memory on
// init() (plain getAll by id) and does ALL filtering/sorting/grouping/aggregation
// in memory — a single family's data is tiny (even a decade of transactions is a
// few thousand rows). Secondary indexes were unused (no indexed read anywhere in
// the app), so they were only write-overhead. If the dataset ever outgrows memory,
// re-add the specific indexes AND wire the adapter's page()/indexed-getAll to use
// them (note: a transactions [accountId,date] index must also cover transfer
// DESTINATIONS, which the old account_date index missed). The adapter's generic
// index/pagination machinery stays — it's exercised by lib.test's own schema.
export const SCHEMA: StorageSchema = {
  version: 3,
  collections: [
    { name: Collections.people },
    { name: Collections.accounts },
    { name: Collections.categories },
    { name: Collections.transactions },
    { name: Collections.holdings },
    { name: Collections.holdingEvents },
    { name: Collections.fxRates },
    { name: Collections.settings },
    { name: Collections.importBatches },
  ],
};
