import { useEffect, useMemo, useState } from "react";
import {
  buildImportPreview,
  clampTaxRate,
  readPortfolioSnapshot,
  type ImportGroupKey,
  type PortfolioSnapshot,
} from "../../utils/portfolioImport";
import { SHARED } from "../../features/portfolio/model/types";
import { todayIso } from "../../lib/util/format";
import { formatCurrency, inputCls, num } from "./format";
import { HELP } from "./help";
import { Field, InfoTip, NumberField } from "./ui";

// Extra explanation for groups whose suggested return needs one.
const GROUP_HELP: Partial<Record<ImportGroupKey, string>> = {
  fd: HELP.importFd,
  bank: HELP.importBank,
};

export interface ImportedBucket {
  name: string;
  amount: number;
  return: number;
  volatility: number;
}

// Inline panel: reads the Portfolio tab's data (read-only), shows the
// grouped values, and lets the user choose what to bring in.
export function PortfolioImportPanel({
  onImport,
  onClose,
  defaultTaxRate,
}: {
  onImport: (buckets: ImportedBucket[], mode: "replace" | "add") => void;
  onClose: () => void;
  // Starting value for "tax rate today" (%), which turns FD and bank interest
  // into after-tax return suggestions.
  defaultTaxRate: number;
}) {
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [owner, setOwner] = useState("all");
  // The imported buckets grow before retirement, so their interest is taxed
  // at today's rate, which may differ from the retirement rate set below.
  const [taxToday, setTaxToday] = useState(defaultTaxRate);
  const [edits, setEdits] = useState<
    Partial<Record<ImportGroupKey, { include?: boolean; ret?: number; vol?: number }>>
  >({});

  useEffect(() => {
    let cancelled = false;
    readPortfolioSnapshot().then(
      (s) => {
        if (!cancelled) setSnapshot(s);
      },
      (e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const preview = useMemo(
    // Local date, the same way the Portfolio values holdings.
    () => (snapshot ? buildImportPreview(snapshot, owner, todayIso(), taxToday) : null),
    [snapshot, owner, taxToday],
  );

  const chosen = (preview?.groups ?? []).map((g) => {
    const e = edits[g.key] ?? {};
    return {
      group: g,
      include: e.include ?? g.includeByDefault,
      ret: e.ret ?? g.suggestedReturn,
      vol: e.vol ?? g.suggestedVolatility,
    };
  });
  const ticked = chosen.filter((c) => c.include);
  const taxApplied = clampTaxRate(taxToday);
  const toBuckets = (): ImportedBucket[] =>
    ticked.map((c) => ({ name: c.group.label, amount: Math.round(c.group.amount), return: c.ret, volatility: c.vol }));
  const edit = (key: ImportGroupKey, p: { include?: boolean; ret?: number; vol?: number }) =>
    setEdits((e) => ({ ...e, [key]: { ...e[key], ...p } }));

  return (
    <div className="mb-4 rounded-md border-2 border-green-300 bg-white p-4">
      <div className="mb-2 flex items-center text-sm font-semibold text-green-900">
        Import from Portfolio
        <InfoTip text={HELP.importPortfolio} label="Import from Portfolio" />
      </div>
      {error && <p className="text-sm text-red-700">Couldn't read Portfolio data: {error}</p>}
      {snapshot === undefined && !error && <p className="text-sm text-gray-600">Reading your Portfolio…</p>}
      {snapshot === null && (
        <p className="text-sm text-gray-600">
          No Portfolio data on this device yet. Add your investments and
          accounts in the Portfolio tab first.
        </p>
      )}
      {preview && (
        <>
          <p className="mb-3 text-xs text-gray-600">
            Your investments and your bank, cash, FD, crypto and property
            account balances, valued the same way as Portfolio's Dashboard and
            grouped by type. Credit cards and loans aren't included. Check the
            suggested returns and volatility before importing: FD and bank
            interest is shown after your tax rate today.
          </p>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            {preview.people.length > 0 && (
              <Field className="w-full max-w-xs" label="Whose money" help={HELP.whoseInvestments}>
                {(id) => (
                  <select id={id} value={owner} onChange={(e) => setOwner(e.target.value)} className={inputCls}>
                    <option value="all">Everyone</option>
                    <option value={SHARED}>Shared only</option>
                    {preview.people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                        {p.archived ? " (archived)" : ""}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )}
            <NumberField
              className="w-40"
              label="Tax rate today %"
              help={HELP.importTaxToday}
              step="0.1"
              min={0}
              max={100}
              value={taxToday}
              onChange={setTaxToday}
            />
          </div>
          {taxApplied !== taxToday && (
            <p className="-mt-2 mb-3 text-xs text-red-700">
              Enter a tax rate from 0 to 100. Until then it counts as {taxApplied}%.
            </p>
          )}
          {chosen.length === 0 ? (
            <p className="text-sm text-gray-600">Nothing with a current value for this selection.</p>
          ) : (
            <div className="space-y-2">
              {chosen.map(({ group, include, ret, vol }) => (
                <div key={group.key} className="grid grid-cols-12 items-end gap-2 rounded border p-2">
                  <div className="col-span-12 sm:col-span-6">
                    <div className="flex items-center gap-2">
                      <input
                        id={`imp-${group.key}`}
                        type="checkbox"
                        checked={include}
                        onChange={(e) => edit(group.key, { include: e.target.checked })}
                      />
                      <label htmlFor={`imp-${group.key}`} className="text-sm text-gray-800">
                        {group.label}: <strong className="whitespace-nowrap">{formatCurrency(group.amount)}</strong>
                      </label>
                      {GROUP_HELP[group.key] && <InfoTip text={GROUP_HELP[group.key]} label={group.label} />}
                    </div>
                    {/* A tap-friendly list (phones have no hover). */}
                    <details className="ml-6 mt-1 text-xs text-gray-600">
                      <summary className="cursor-pointer">
                        {group.items.length === 1 ? "1 item" : `${group.items.length} items`}
                      </summary>
                      <ul className="mt-1 list-disc pl-5">
                        {group.items.map((name, i) => (
                          <li key={`${name}-${i}`}>{name}</li>
                        ))}
                      </ul>
                    </details>
                  </div>
                  <Field className="col-span-6 sm:col-span-3" label="Return %" help={HELP.returnAfterTax}>
                    {(id) => (
                      <input id={id} type="number" step="0.1" value={ret} onChange={(e) => edit(group.key, { ret: num(e.target.value) })} className={inputCls} />
                    )}
                  </Field>
                  <Field className="col-span-6 sm:col-span-3" label="Volatility %" help={HELP.importVolatility}>
                    {(id) => (
                      <input id={id} type="number" step="0.5" min={0} value={vol} onChange={(e) => edit(group.key, { vol: num(e.target.value) })} className={inputCls} />
                    )}
                  </Field>
                </div>
              ))}
            </div>
          )}
          {preview.skipped.length > 0 && (
            <details className="mt-2 text-xs text-amber-800">
              <summary className="cursor-pointer">
                {preview.skipped.length} item(s) left out (see why)
              </summary>
              <ul className="mt-1 list-disc pl-5">
                {preview.skipped.map((s, i) => (
                  <li key={`${s.name}-${i}`}>
                    {s.name}: {s.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {preview && ticked.length > 0 && (
        <p className="mt-3 text-sm text-gray-800">
          Total to import:{" "}
          <strong className="whitespace-nowrap">
            {formatCurrency(ticked.reduce((sum, c) => sum + c.group.amount, 0))}
          </strong>
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {preview && ticked.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => onImport(toBuckets(), "replace")}
              className="rounded-md bg-green-600 px-3 py-1.5 text-sm text-white hover:bg-green-700"
            >
              Replace my buckets
            </button>
            <button
              type="button"
              onClick={() => onImport(toBuckets(), "add")}
              className="rounded-md border border-green-600 px-3 py-1.5 text-sm text-green-800 hover:bg-green-50"
            >
              Add to my buckets
            </button>
          </>
        )}
        <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100">
          Cancel
        </button>
      </div>
    </div>
  );
}
