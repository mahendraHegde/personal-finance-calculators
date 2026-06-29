// Shows what an incoming snapshot will change BEFORE it replaces local data.
//
// Performance on large diffs (years of transactions): collections are collapsed
// by default, so the initial render is just a handful of summary rows regardless
// of diff size. Expanding a collection renders at most ROW_CAP rows inside a
// bounded, scrollable box (with a "+N more" note), so the DOM stays small and
// scrolling stays smooth even for thousands of changes.

import { useState } from "react";
import type { CollectionDiff, DatasetDiff, Keyed } from "../../../lib/sync/diff";
import { UI } from "../../../config";
import { Badge, Button, Modal } from "./components";

const ROW_CAP = UI.DIFF_ROW_CAP; // max records rendered per section — keeps the DOM bounded

/** Compact display of any field value (objects truncated). */
function val(v: unknown): string {
  if (v === undefined || v === null) return "—";
  if (typeof v === "object") {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 79)}…` : s;
  }
  return String(v);
}

/** Best-effort one-line label for a record, across any collection. */
function summarize(rec: Keyed): string {
  const r = rec as unknown as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof r.date === "string") parts.push(r.date);
  if (typeof r.name === "string" && r.name) parts.push(r.name);
  if (typeof r.type === "string") parts.push(r.type);
  if (typeof r.amount === "number") parts.push(String(r.amount));
  if (r.units !== undefined && r.price !== undefined) parts.push(`${val(r.units)}×${val(r.price)}`);
  if (typeof r.note === "string" && r.note) parts.push(`"${r.note}"`);
  return parts.length ? parts.join(" · ") : rec.id;
}

function MoreNote({ count }: { count: number }) {
  if (count <= ROW_CAP) return null;
  return <li className="py-1 italic text-slate-400">+{count - ROW_CAP} more not shown</li>;
}

function CollectionSection({ name, d }: { name: string; d: CollectionDiff<Keyed> }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="py-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left"
      >
        <span className="capitalize text-slate-700">
          <span className="mr-1 inline-block w-3 text-slate-400">{open ? "▾" : "▸"}</span>
          {name}
        </span>
        <span className="text-xs text-slate-500">
          +{d.added.length} / ~{d.modified.length} / −{d.removed.length}
        </span>
      </button>
      {open && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-md bg-slate-50 p-2 text-xs">
          <ul className="space-y-0.5">
            {d.added.slice(0, ROW_CAP).map((r) => (
              <li key={`a-${r.id}`} className="text-green-700">
                + {summarize(r)}
              </li>
            ))}
            <MoreNote count={d.added.length} />
            {d.modified.slice(0, ROW_CAP).map((m) => (
              <li key={`m-${m.id}`} className="text-amber-700">
                ~ {summarize(m.after)}
                <ul className="ml-4 text-slate-500">
                  {m.changes.map((f) => (
                    <li key={f}>
                      {f}: {val((m.before as unknown as Record<string, unknown>)[f])} →{" "}
                      {val((m.after as unknown as Record<string, unknown>)[f])}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
            <MoreNote count={d.modified.length} />
            {d.removed.slice(0, ROW_CAP).map((r) => (
              <li key={`r-${r.id}`} className="text-red-700">
                − {summarize(r)}
              </li>
            ))}
            <MoreNote count={d.removed.length} />
          </ul>
        </div>
      )}
    </li>
  );
}

export function DiffModal({
  diff,
  remoteVersion,
  onConfirm,
  onCancel,
}: {
  diff: DatasetDiff;
  remoteVersion: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const rows = Object.entries(diff.collections).filter(
    ([, d]) => d.added.length || d.removed.length || d.modified.length,
  );

  return (
    <Modal title={`Load snapshot v${remoteVersion}?`} onClose={onCancel}>
      <div className="space-y-4">
        {diff.summary.changed ? (
          <>
            <p className="text-sm text-slate-600">
              This will replace your local data. Tap a section to see exactly what changes:
            </p>
            <div className="flex flex-wrap gap-2">
              <Badge tone="green">+{diff.summary.added} added</Badge>
              <Badge tone="amber">{diff.summary.modified} modified</Badge>
              <Badge tone="red">−{diff.summary.removed} removed</Badge>
            </div>
            <ul className="divide-y divide-slate-100 text-sm">
              {rows.map(([name, d]) => (
                <CollectionSection key={name} name={name} d={d} />
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-slate-600">
            The data is identical to what you have. You can still load it to acknowledge this newer
            version — that re-enables syncing (it was blocked on "Remote has newer changes").
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Keep local
          </Button>
          {/* Always enabled: even an identical newer version must be loadable so
              the user can acknowledge it (advancing the synced version) and
              un-stick a sync blocked by a newer remote. */}
          <Button onClick={onConfirm}>
            {diff.summary.changed ? "Load snapshot" : "Acknowledge version"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
