// UI pieces every CSV importer needs: "which column is which", "what does this value
// mean", and "here's what we couldn't use". Shared by the holdings and transaction
// importers so the mapping experience (and its accessibility/layout fixes) lives once.

import { Badge, Field, Select } from "./components";
import type { SkippedImportRow } from "../domain/import/common";

export interface ColumnSpec<K extends string> {
  key: K;
  label: string;
  hint?: string;
}

/** Grid of "field → which CSV column" dropdowns, one per spec. `onChange` receives the
 *  field key so a caller can react to a specific field (e.g. sniff day-first on `date`). */
export function ColumnMapGrid<K extends string>({
  specs,
  headers,
  value,
  onChange,
}: {
  specs: Array<ColumnSpec<K>>;
  headers: string[];
  value: Record<K, string>;
  onChange: (key: K, column: string) => void;
}) {
  const options = [{ value: "", label: "— none —" }, ...headers.map((h) => ({ value: h, label: h }))];
  return (
    // One column on a phone (two cramped selects per row is unusable), widening with space.
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {specs.map((s) => (
        <Field key={s.key} label={s.label} hint={s.hint}>
          <Select value={value[s.key] ?? ""} onChange={(v) => onChange(s.key, v)} options={options} />
        </Field>
      ))}
    </div>
  );
}

/** Rows of "this value in your file → what it means here", used for mapping a type
 *  column (buy/sell, debit/credit) and for mapping banks / owners / categories onto
 *  existing records (or new ones). `count` shows how many rows carry each value, so the
 *  user can see what matters. */
export function ValueMapRows({
  values,
  options,
  value,
  onChange,
  counts,
  labels,
  emptyLabel = "Nothing to map.",
}: {
  /** The mapping KEYS (usually the raw file values; for pairs, a composite key). */
  values: string[];
  options: Array<{ value: string; label: string }>;
  value: Record<string, string>;
  onChange: (raw: string, mapped: string) => void;
  counts?: Record<string, number>;
  /** Optional display text per key, when the key isn't what the user should read
   *  (e.g. a "category › subcategory" pair keyed by a composite string). */
  labels?: Record<string, string>;
  emptyLabel?: string;
}) {
  if (values.length === 0) return <p className="text-xs text-slate-400">{emptyLabel}</p>;
  return (
    <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
      {values.map((raw) => (
        // Stacked on a phone (a full-width select is tappable); side-by-side from `sm`.
        <li key={raw} className="flex flex-col gap-1 p-2 sm:flex-row sm:items-center sm:gap-3">
          <span className="min-w-0 flex-1 break-words text-sm text-slate-700 sm:truncate" title={raw}>
            {labels?.[raw] ?? raw}
            {counts?.[raw] ? <span className="ml-1 text-xs text-slate-400">({counts[raw]})</span> : null}
          </span>
          <div className="w-full sm:w-48 sm:shrink-0">
            <Select value={value[raw] ?? ""} onChange={(v) => onChange(raw, v)} options={options} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Collapsible list of rows an import could NOT use, each with its reason — so nothing is
 *  ever silently dropped. Bounded so a pathological file can't blow up the DOM. */
export function SkippedRowsPanel({
  rows,
  open,
  onToggle,
  cap = 100,
}: {
  rows: SkippedImportRow[];
  open: boolean;
  onToggle: () => void;
  cap?: number;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="rounded-lg border border-slate-200">
      <button onClick={onToggle} className="flex w-full items-center justify-between p-2 text-left text-sm">
        <span className="text-slate-600">
          {rows.length} row{rows.length === 1 ? "" : "s"} skipped — nothing is imported from {rows.length === 1 ? "it" : "them"}
        </span>
        <span className="text-xs text-blue-600">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <ul className="max-h-64 divide-y divide-slate-100 overflow-y-auto border-t border-slate-100 text-xs">
          {rows.slice(0, cap).map((r, i) => (
            <li key={`${r.row}-${i}`} className="p-2">
              <div className="flex items-center gap-2">
                <Badge tone="amber">row {r.row}</Badge>
                <span className="text-slate-600">{r.reason}</span>
              </div>
              <div className="mt-1 truncate text-slate-400">
                {Object.entries(r.cells)
                  .filter(([, v]) => v !== "")
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ")}
              </div>
            </li>
          ))}
          {rows.length > cap && <li className="p-2 text-slate-400">+{rows.length - cap} more…</li>}
        </ul>
      )}
    </div>
  );
}
