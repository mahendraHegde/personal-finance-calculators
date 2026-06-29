// Portfolio feature root: provider + responsive tab navigation + view switch.

import { useState } from "react";
import { Boxes, LayoutDashboard, Receipt, Settings as SettingsIcon, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { PortfolioProvider } from "../state/PortfolioProvider";
import { useSyncStatus } from "../state/context";
import { NavContext, type TabId } from "./navigation";
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

function SyncPill() {
  const status = useSyncStatus();
  // Sync is optional — not connecting reads as a calm "Local only", not an error.
  const { label, tone } =
    status.phase === "ready"
      ? { label: "Synced", tone: "text-green-600" }
      : status.phase === "syncing"
        ? { label: "Syncing…", tone: "text-green-600" }
        : status.phase === "error"
          ? { label: "Sync error", tone: "text-red-600" }
          : { label: "Local only", tone: "text-slate-400" };
  return <span className={`text-xs ${tone}`}>● {label}</span>;
}

function NoEncryptionBanner({ onFix }: { onFix: () => void }) {
  const status = useSyncStatus();
  // Only when NO password is set at all. (A "locked" vault IS encrypted — it just
  // needs unlocking — so it must not show this "not encrypted" warning.)
  if (status.phase !== "no-vault") return null;
  return (
    <div className="border-b border-amber-200 bg-amber-50">
      <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-2">
        <span className="text-xs text-amber-800">
          ⚠️ No backup password set — your backups and any Google Drive sync won't be encrypted.
        </span>
        <button
          onClick={onFix}
          className="shrink-0 rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700"
        >
          Set a password
        </button>
      </div>
    </div>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>("dashboard");
  return (
    <NavContext.Provider value={setTab}>
    <div className="min-h-screen bg-slate-50 pb-20 sm:pb-0">
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

      <main className="mx-auto max-w-4xl px-4 py-6">
        {tab === "dashboard" && <Dashboard />}
        {tab === "expenses" && <Expenses />}
        {tab === "investments" && <Investments />}
        {tab === "accounts" && <Accounts />}
        {tab === "settings" && <Settings />}
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

export function PortfolioApp() {
  return (
    <PortfolioProvider>
      <Shell />
    </PortfolioProvider>
  );
}
