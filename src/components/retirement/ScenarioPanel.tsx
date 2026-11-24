import { Columns3 } from "lucide-react";
import { useState } from "react";
import type { CompareRow } from "../../utils/retirementJobs";
import {
  listScenarios,
  newScenarioId,
  saveScenarios,
  type RetirementCalculatorConfig,
  type RetirementScenario,
} from "../../utils/storage";
import { formatCurrency, formatPct, inputCls } from "./format";
import { HELP } from "./help";
import { toMcParams } from "./params";
import type { RetirementWorkerClient } from "./workerClient";
import { Field, InfoTip, Section } from "./ui";

const CURRENT = "current";

export function ScenarioPanel({
  config,
  onLoad,
  client,
}: {
  config: RetirementCalculatorConfig;
  onLoad: (config: RetirementCalculatorConfig) => void;
  client: RetirementWorkerClient | null;
}) {
  const [scenarios, setScenarios] = useState<RetirementScenario[]>(listScenarios);
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const persist = (next: RetirementScenario[]) => {
    setScenarios(next);
    if (!saveScenarios(next)) setMessage("Couldn't save in this browser (storage full or blocked).");
  };
  const save = () => {
    const trimmed = name.trim() || `Plan ${scenarios.length + 1}`;
    persist([
      ...scenarios,
      { id: newScenarioId(), name: trimmed, savedAt: new Date().toISOString(), config },
    ]);
    setName("");
    setMessage(`Saved "${trimmed}".`);
  };
  const remove = (id: string) => {
    persist(scenarios.filter((s) => s.id !== id));
    setSelected((sel) => {
      const next = new Set(sel);
      next.delete(id);
      return next;
    });
  };
  const toggle = (id: string) =>
    setSelected((sel) => {
      const next = new Set(sel);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const compare = () => {
    if (!client) return;
    const items = [
      { key: CURRENT, params: toMcParams(config) },
      ...scenarios
        .filter((s) => selected.has(s.id))
        .map((s) => ({ key: s.id, params: toMcParams(s.config) })),
    ];
    setRunning(true);
    client.run({ kind: "compare", items }).then(
      (r) => {
        setRows(r);
        setRunning(false);
      },
      (e: unknown) => {
        setMessage(`Compare failed: ${e instanceof Error ? e.message : String(e)}`);
        setRunning(false);
      },
    );
  };
  const nameOf = (key: string) =>
    key === CURRENT ? "Current inputs" : (scenarios.find((s) => s.id === key)?.name ?? "Deleted plan");

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Columns3 size={20} />
          Saved Plans & Compare
        </span>
      }
      help={HELP.scenarios}
      helpLabel="Saved Plans & Compare"
      tone="bg-violet-50 text-violet-800"
    >
      <div className="flex flex-wrap items-end gap-2">
        <Field className="min-w-0 flex-1" label="Save current inputs as">
          {(id) => (
            <input
              id={id}
              type="text"
              value={name}
              placeholder={`Plan ${scenarios.length + 1}`}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
            />
          )}
        </Field>
        <button
          type="button"
          onClick={save}
          className="rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700"
        >
          Save plan
        </button>
      </div>
      {message && <p className="mt-2 text-xs text-gray-600">{message}</p>}
      {scenarios.length > 0 && (
        <ul className="mt-3 space-y-2">
          {scenarios.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 rounded border bg-white p-2 text-sm">
              <input
                id={`cmp-${s.id}`}
                type="checkbox"
                checked={selected.has(s.id)}
                onChange={() => toggle(s.id)}
                aria-label={`Include ${s.name} in comparison`}
              />
              <label htmlFor={`cmp-${s.id}`} className="min-w-0 flex-1 truncate font-medium text-gray-800">
                {s.name}
                <span className="ml-2 text-xs font-normal text-gray-500">
                  {new Date(s.savedAt).toLocaleDateString("en-IN")}
                </span>
              </label>
              <button
                type="button"
                onClick={() => {
                  onLoad(s.config);
                  setMessage(`Loaded "${s.name}" into the calculator.`);
                }}
                className="rounded border border-violet-300 px-2 py-1 text-xs text-violet-800 hover:bg-violet-100"
              >
                Load
              </button>
              <button
                type="button"
                onClick={() => remove(s.id)}
                className="rounded border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50"
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={compare}
          disabled={!client || running}
          className="rounded-md border border-violet-400 bg-white px-4 py-2 text-sm font-medium text-violet-800 hover:bg-violet-100 disabled:opacity-50"
        >
          {running ? "Comparing…" : `Compare current${selected.size ? ` with ${selected.size} saved` : ""}`}
        </button>
        <InfoTip text={HELP.compare} label="Compare" />
      </div>
      {rows && (
        <div className="mt-3 overflow-x-auto rounded border bg-white">
          <table className="w-full min-w-max text-left text-xs">
            <thead className="bg-violet-100 text-violet-900">
              <tr>
                <th className="px-2 py-1">
                  <span className="flex items-center">
                    Plan
                    <InfoTip text={HELP.compareRows} label="Comparison rows" />
                  </span>
                </th>
                {rows.map((r) => (
                  <th key={r.key} className="px-2 py-1">
                    {nameOf(r.key)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Retire at", (r) => String(r.retirementAge)],
                  ["Monthly saving", (r) => formatCurrency(r.monthlySaving)],
                  ["Yearly spend (today)", (r) => formatCurrency(r.annualSpend)],
                  ["Savings at retirement (today's ₹)", (r) => formatCurrency(r.corpusAtRetirementToday)],
                  ["First-year withdrawal rate", (r) => formatPct(r.withdrawalRate)],
                  ["Expected path lasts to", (r) => (r.lastsToAge === null ? `${r.horizonAge}+` : String(Math.floor(r.lastsToAge)))],
                  ["Success rate", (r) => formatPct(r.successRate, 0)],
                  ["Bad case lasts to", (r) => (r.badCaseAge >= r.targetAge ? `${r.targetAge}+` : String(Math.floor(r.badCaseAge)))],
                ] as [string, (r: CompareRow["summary"]) => string][]
              ).map(([label, fmt]) => (
                <tr key={label} className="border-t">
                  <td className="px-2 py-1 font-medium text-gray-700">{label}</td>
                  {rows.map((r) => (
                    <td key={r.key} className="px-2 py-1">
                      {fmt(r.summary)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
