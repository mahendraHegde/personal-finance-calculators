// Wires the store + sync controller into React. Opens IndexedDB once, restores
// the vault key from the keystore (so refresh doesn't re-prompt), reconfigures
// Drive from saved settings, and starts autosave. Components read reactive
// state via useSyncExternalStore.

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { openIndexedDB } from "../../../lib/storage/indexeddb-adapter";
import { DB_NAME, SCHEMA } from "../model/schema";
import { createPortfolioStore } from "./store";
import { SyncController } from "./sync-controller";
import { fetchUsdRates } from "../../../lib/fx/fx-service";
import { FX } from "../../../config";
import { PortfolioContext, type PortfolioContextValue } from "./context";

/** Refresh FX at most once per interval. The throttle key is `settings.fxUpdatedAt`,
 *  which is PERSISTED — so the window also holds across reloads, not just within
 *  a session. */
const FX_MAX_AGE_MS = FX.REFRESH_INTERVAL_MS;

function fxIsStale(updatedAt: string | undefined): boolean {
  if (!updatedAt) return true; // never fetched
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return true; // corrupt timestamp → refetch
  return Date.now() - t > FX_MAX_AGE_MS;
}

export function PortfolioProvider({ children }: { children: ReactNode }) {
  const [ctx, setCtx] = useState<PortfolioContextValue | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let stopAutosave: (() => void) | undefined;
    let fxTimer: ReturnType<typeof setInterval> | undefined;
    let fxFetching = false;
    (async () => {
      try {
        const adapter = await openIndexedDB(DB_NAME, SCHEMA);
        const store = await createPortfolioStore(adapter);
        const sync = new SyncController(store);
        await sync.restoreFromKeystore().catch(() => {});
        const drive = store.getState().settings.drive;
        if (drive?.clientId) {
          sync.configureDrive(drive.clientId);
          // If a restored key belongs to a different folder's vault, drop it
          // before autosave can push a forked snapshot under the wrong key.
          await sync.reconcileVaultWithFolder().catch(() => {});
        }
        // Unmounted while initialising (e.g. StrictMode double-invoke): bail
        // before subscribing so we never leak an autosave subscription.
        if (!active) return;
        stopAutosave = sync.startAutosave();
        // Best-effort durable storage so mobile browsers don't evict us.
        void navigator.storage?.persist?.();
        setCtx({ store, sync });

        // Lazily refresh FX on load if the cached rates are missing/stale, then
        // re-check hourly while the tab stays open. Fire-and-forget: a failed
        // fetch (offline / provider down) keeps the last cached rates rather
        // than blocking the UI. Throttled by `fxUpdatedAt`, so it never hits the
        // provider more than once an hour even across rapid reloads.
        const refreshFxIfStale = () => {
          if (!active || fxFetching) return;
          if (!fxIsStale(store.getState().settings.fxUpdatedAt)) return;
          fxFetching = true;
          void fetchUsdRates()
            .then((table) => (active ? store.cacheFxRates(table) : undefined))
            .catch(() => {})
            .finally(() => {
              fxFetching = false;
            });
        };
        refreshFxIfStale();
        fxTimer = setInterval(refreshFxIfStale, FX_MAX_AGE_MS);
      } catch (e) {
        if (active) setError(String(e));
      }
    })();
    return () => {
      active = false;
      stopAutosave?.();
      if (fxTimer !== undefined) clearInterval(fxTimer);
    };
  }, []);

  if (error) {
    return (
      <div className="p-6 text-center text-red-600">
        Failed to open local database: {error}
      </div>
    );
  }
  if (!ctx) {
    return <div className="p-6 text-center text-slate-500">Loading…</div>;
  }
  return <PortfolioContext.Provider value={ctx}>{children}</PortfolioContext.Provider>;
}
