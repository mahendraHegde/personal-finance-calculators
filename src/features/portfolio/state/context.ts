// React context + hooks for the portfolio store/sync. Kept separate from the
// provider component so each module exports a single concern (and Fast Refresh
// stays happy).

import { createContext, useContext, useSyncExternalStore } from "react";
import type { PortfolioState, PortfolioStore } from "./store";
import type { SyncController, SyncStatus } from "./sync-controller";

export interface PortfolioContextValue {
  store: PortfolioStore;
  sync: SyncController;
}

export const PortfolioContext = createContext<PortfolioContextValue | null>(null);

function useCtx(): PortfolioContextValue {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error("usePortfolio must be used within <PortfolioProvider>");
  return ctx;
}

export function usePortfolio(): {
  state: PortfolioState;
  store: PortfolioStore;
  sync: SyncController;
} {
  const { store, sync } = useCtx();
  const state = useSyncExternalStore(store.subscribe, store.getState);
  return { state, store, sync };
}

export function useSyncStatus(): SyncStatus {
  const { sync } = useCtx();
  return useSyncExternalStore(sync.subscribe, sync.getStatus);
}
