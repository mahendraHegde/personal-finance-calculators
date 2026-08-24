// Portfolio feature root: provider + responsive tab navigation + view switch.

import { useEffect, useRef, useState } from "react";
import { Boxes, LayoutDashboard, Receipt, Settings as SettingsIcon, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PortfolioProvider } from "../state/PortfolioProvider";
import { usePortfolio, useSyncStatus } from "../state/context";
import {
  refundsCheckSlot,
  syncSituation,
  type SyncActionKind,
  type SyncNoticeSpec,
  type SyncSituation,
  SYNC_TONE_COLOR,
} from "./sync-readings";
import { NavContext, type TabId } from "./navigation";
import type { BadgeTone } from "./components";
import { Dashboard } from "./Dashboard";
import { Expenses } from "./Expenses";
import { Investments } from "./Investments";
import { Accounts } from "./Accounts";
import { Settings } from "./Settings";

type Tab = TabId;

const TABS: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "expenses", label: "Transactions", icon: Receipt },
  { id: "investments", label: "Investments", icon: TrendingUp },
  { id: "accounts", label: "Manage", icon: Boxes },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function useSituation(dismissedApplied: number | null = null): SyncSituation {
  return syncSituation(useSyncStatus(), { dismissedApplied });
}

/** Text colours by COLOUR NAME, not by meaning — which meaning is which colour is decided once,
 *  in `SYNC_TONE_COLOR`, and shared with the Settings badge. */
const PILL_COLOR: Record<BadgeTone, string> = {
  green: "text-green-600",
  amber: "text-amber-600",
  red: "text-red-600",
  slate: "text-slate-400",
  blue: "text-blue-600",
};

function SyncPill() {
  const { pill } = useSituation();
  return (
    <span className={`shrink-0 whitespace-nowrap text-xs ${PILL_COLOR[SYNC_TONE_COLOR[pill.tone]]}`} title={pill.title}>
      ● {pill.label}
    </span>
  );
}

/** Blocks the app while the folder is checked on start — a stale device must not be edited
 *  before the user knows there is something to load. */
function CheckingOverlay() {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-50/90"
      role="status"
      aria-busy="true"
    >
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-blue-600" />
        <p className="text-sm text-slate-600">Checking your other devices…</p>
        <p className="text-xs text-slate-400">Loading anything new before you start.</p>
      </div>
    </div>
  );
}

/** Standing notices for the states the user must not miss. Every rule about WHICH of them
 *  stand, and in what order, lives in `syncSituation` — this only binds actions to handlers. */
function SyncNotice({
  onReview,
  onSettings,
  onDismissApplied,
  dismissedApplied,
}: {
  onReview: () => void;
  onSettings: () => void;
  onDismissApplied: () => void;
  dismissedApplied: number | null;
}) {
  const { notices } = useSituation(dismissedApplied);
  if (notices.length === 0) return null;
  const handlers: Record<SyncActionKind, () => void> = {
    settings: onSettings,
    review: onReview,
    "dismiss-applied": onDismissApplied,
  };
  return (
    <>
      {notices.map((n) => (
        <Notice key={n.key} tone={n.tone} action={n.action.label} onAction={handlers[n.action.kind]} title={n.title}>
          {n.text}
        </Notice>
      ))}
    </>
  );
}

const NOTICE_STYLE: Record<SyncNoticeSpec["tone"], string> = {
  red: "border-red-200 bg-red-50 text-red-800",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  green: "border-green-200 bg-green-50 text-green-800",
  slate: "border-slate-200 bg-slate-100 text-slate-600",
};

function Notice({
  tone,
  action,
  onAction,
  children,
  title,
  emphasis,
}: {
  tone: SyncNoticeSpec["tone"];
  action: string;
  onAction: () => void;
  children: React.ReactNode;
  /** Raw diagnostic text, on hover only — the visible sentence must stand on its own. */
  title?: string;
  /** A filled button, for the one notice that is a call to action rather than a status. */
  emphasis?: boolean;
}) {
  // A table keyed by the union, not an if-chain with a silent `else`: adding a tone must be a
  // compile error here, not a banner that quietly renders slate.
  const cls = NOTICE_STYLE[tone];
  return (
    <div className={`border-b ${cls}`} role="status">
      <div className="mx-auto flex max-w-4xl flex-col items-start gap-2 px-4 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        {/* `title` on the SENTENCE, not the row: on the row it also covered the button, so hovering
            "Try again" showed "decrypt failed: bad MAC". */}
        <span className="text-xs" title={title}>
          {children}
        </span>
        <button
          onClick={onAction}
          className={`min-h-9 shrink-0 rounded-md px-3 py-2 text-xs font-medium ${
            emphasis ? "bg-amber-600 text-white hover:bg-amber-700" : "bg-white shadow-sm"
          }`}
        >
          {action}
        </button>
      </div>
    </div>
  );
}

function NoEncryptionBanner({ onFix }: { onFix: () => void }) {
  const status = useSyncStatus();
  // Only when NO password is set at all. (A "locked" vault IS encrypted — it just needs
  // unlocking — so it must not show this "not encrypted" warning.)
  if (status.phase !== "no-vault") return null;
  return (
    // Same component as the sync notices: the two used to be separate copies of one row, and this
    // diff caught itself applying the same responsive + tap-target change to both by hand.
    <Notice tone="amber" action="Set a password" onAction={onFix} emphasis>
      ⚠️ No backup password set — your backups and any Google Drive sync won't be encrypted.
    </Notice>
  );
}

function Shell({ onGating }: { onGating?: (gating: boolean) => void }) {
  const [tab, setTab] = useState<Tab>("dashboard");
  const { sync } = usePortfolio();
  const status = useSyncStatus();
  const [inFlight, setInFlight] = useState(0);
  const [reviewRequest, setReviewRequest] = useState(0);
  const [dismissedApplied, setDismissedApplied] = useState<number | null>(null);
  const done = useRef<"none" | "locked" | "full">("none");

  // ONCE per app start, plus once more when the vault opens — a locked vault can list but not
  // decode, so that second run is the one that can actually offer what's waiting. No
  // focus/visibility listeners: the point is to catch the stale-on-open case, not to poll.
  //
  // Runs are chained, never concurrent: an unlock landing inside the first run's window would
  // otherwise interleave two checks whose late writes contradict each other.
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (status.phase === "no-vault") return;
    const locked = status.phase === "locked";
    // The slot records what has actually COMPLETED, so a failed locked run doesn't consume the
    // full-check slot it never performed.
    if (done.current === "full" || (done.current === "locked" && locked)) return;
    const claim = locked ? "locked" : "full";
    done.current = claim;
    setInFlight((n) => n + 1);
    chain.current = chain.current
      .then(() => sync.startupCheck())
      .then((result) => {
        // The result is acted on here and then dropped: every number the UI shows comes from live
        // `SyncStatus`, and a frozen copy of the same facts could only contradict it — a vault
        // re-locked after the check would still be offered "Review now", which cannot decode.
        if (result.kind === "review") {
          // Straight into the existing, reviewed pull/merge flow — dismissible, and the notice
          // above keeps saying they're behind until it's done.
          setTab("settings");
          setReviewRequest((n) => n + 1);
        }
        // `done.current === claim` first: a newer run may already own the slot.
        if (done.current === claim && refundsCheckSlot(result.kind, claim)) done.current = "none";
      })
      // A rejection here would poison `chain` for the rest of the session, so the post-unlock
      // check would never run — and the overlay's `.finally` is the only thing that lifts `inert`.
      .catch(() => {})
      .finally(() => setInFlight((n) => Math.max(0, n - 1)));
  }, [sync, status.phase]);

  const checking = inFlight > 0;
  useEffect(() => {
    onGating?.(checking);
  }, [onGating, checking]);
  // `inert` blurs whatever was focused, and the second run fires on unlock — i.e. right after the
  // user typed their passphrase — so without this the caret (and the mobile keyboard) is dropped
  // mid-flow and lands nowhere.
  const focusBefore = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (checking) {
      focusBefore.current = document.activeElement as HTMLElement | null;
      return;
    }
    const el = focusBefore.current;
    focusBefore.current = null;
    if (el?.isConnected && el !== document.body) el.focus();
  }, [checking]);

  const openReview = (): void => {
    setTab("settings");
    setReviewRequest((n) => n + 1); // a NEW value every time, so it fires even from Settings
  };

  return (
    <NavContext.Provider value={setTab}>
    <>
      {checking && <CheckingOverlay />}
      <div className="min-h-screen bg-slate-50 pb-20 sm:pb-0" inert={checking || undefined}>
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
          <h1 className="text-lg font-bold text-slate-800">Portfolio</h1>
          <SyncPill />
        </div>
        {/* Desktop tabs */}
        <nav className="mx-auto hidden max-w-4xl gap-1 px-4 sm:flex">
          {TABS.map((t) => (
            <TabButton key={t.id} active={tab === t.id} onClick={() => setTab(t.id)} icon={t.icon}>
              {t.label}
            </TabButton>
          ))}
        </nav>
      </header>

      <NoEncryptionBanner onFix={() => setTab("settings")} />
      <SyncNotice
        onReview={openReview}
        onSettings={() => setTab("settings")}
        onDismissApplied={() => setDismissedApplied(status.appliedVersion ?? null)}
        dismissedApplied={dismissedApplied}
      />

      <main className="mx-auto max-w-4xl px-4 py-6">
        {tab === "dashboard" && <Dashboard />}
        {tab === "expenses" && <Expenses />}
        {tab === "investments" && <Investments />}
        {tab === "accounts" && <Accounts />}
        {tab === "settings" && (
          <Settings reviewRequest={reviewRequest} onReviewHandled={() => setReviewRequest(0)} />
        )}
      </main>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-10 flex justify-around border-t border-slate-200 bg-white sm:hidden">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] ${
                tab === t.id ? "text-blue-600" : "text-slate-400"
              }`}
            >
              <Icon size={20} />
              {t.label}
            </button>
          );
        })}
      </nav>
      </div>
    </>
    </NavContext.Provider>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  children: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium transition ${
        active
          ? "border-blue-600 text-blue-600"
          : "border-transparent text-slate-500 hover:text-slate-700"
      }`}
    >
      <Icon size={16} />
      {children}
    </button>
  );
}

/** `onGating` reports the startup check to whatever hosts this app. The overlay is
 *  `fixed inset-0` and covers the whole page, but `inert` can only cover this component's own
 *  subtree — anything rendered ALONGSIDE it (the app switcher) stayed keyboard-reachable behind
 *  the overlay, so a tab-and-enter could land the user in another app they could no longer see. */
export function PortfolioApp({ onGating }: { onGating?: (gating: boolean) => void } = {}) {
  return (
    <PortfolioProvider>
      <Shell onGating={onGating} />
    </PortfolioProvider>
  );
}
