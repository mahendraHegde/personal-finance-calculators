// Typed repository bundle over the generic StorageAdapter. The rest of the app
// talks to these typed collections, never to the adapter directly — so the
// backing store stays swappable.

import type { Collection, StorageAdapter } from "../../../lib/storage/types";
import { Collections } from "../model/schema";
import type {
  Account,
  Category,
  FxRateSnapshot,
  Holding,
  HoldingEvent,
  Person,
  Transaction,
} from "../model/types";

export interface PortfolioRepo {
  people: Collection<Person>;
  accounts: Collection<Account>;
  categories: Collection<Category>;
  transactions: Collection<Transaction>;
  holdings: Collection<Holding>;
  holdingEvents: Collection<HoldingEvent>;
  fxRates: Collection<FxRateSnapshot>;
}

export function createPortfolioRepo(storage: StorageAdapter): PortfolioRepo {
  return {
    people: storage.collection<Person>(Collections.people),
    accounts: storage.collection<Account>(Collections.accounts),
    categories: storage.collection<Category>(Collections.categories),
    transactions: storage.collection<Transaction>(Collections.transactions),
    holdings: storage.collection<Holding>(Collections.holdings),
    holdingEvents: storage.collection<HoldingEvent>(Collections.holdingEvents),
    fxRates: storage.collection<FxRateSnapshot>(Collections.fxRates),
  };
}
