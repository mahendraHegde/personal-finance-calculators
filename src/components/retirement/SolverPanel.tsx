import { Target } from "lucide-react";
import { useState } from "react";
import type { MonteCarloParams } from "../../types/retirement";
import type { GapSolution } from "../../utils/retirementSolver";
import { formatCurrency, formatPct } from "./format";
import { HELP } from "./help";
import type { RetirementWorkerClient } from "./workerClient";
import { Field, Section } from "./ui";

export function SolverPanel({
  client,
  params,
  target,
  onTarget,
  plannedRetirementAge,
  alreadyRetired,
  currentSpend,
  expenseType,
}: {
  client: RetirementWorkerClient | null;
  params: MonteCarloParams;
  target: number;
  onTarget: (t: number) => void;
  plannedRetirementAge: number;
  alreadyRetired: boolean;
  currentSpend: number;
  expenseType: "monthly" | "yearly";
}) {
  // The target box edits freely and is clamped to 50 to 99% when you leave
  // it or press Enter (clamping on every keystroke made "95" impossible to
  // type).
  const [targetText, setTargetText] = useState<string | null>(null);
  // The target as typed (clamped), or the saved one if nothing is pending.
  const effectiveTarget = (): number => {
    if (targetText === null || targetText.trim() === "") return target;
    const v = Number(targetText);
    return Number.isFinite(v) ? Math.min(0.99, Math.max(0.5, v / 100)) : target;
  };
  const commitTarget = () => {
    if (targetText === null) return;
    onTarget(effectiveTarget());
    setTargetText(null);
  };
  const [result, setResult] = useState<{ solution: GapSolution; forParams: MonteCarloParams; forTarget: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stale = result !== null && (result.forParams !== params || result.forTarget !== target);
  const per = expenseType === "monthly" ? "a month" : "a year";

  const run = () => {
    if (!client) return;
    const forTarget = effectiveTarget();
    commitTarget();
    setRunning(true);
    setError(null);
    const forParams = params;
    client.run({ kind: "solve", params: forParams, target: forTarget }).then(
      (solution) => {
        setResult({ solution, forParams, forTarget });
        setRunning(false);
      },
      (e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
        setRunning(false);
      },
    );
  };

  const s = result?.solution;
  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Target size={20} />
          What would it take?
        </span>
      }
      help={HELP.solver}
      helpLabel="What would it take?"
      tone="bg-cyan-50 text-cyan-800"
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Target success rate %" help={HELP.solverTarget}>
          {(id) => (
            <input
              id={id}
              type="number"
              min={50}
              max={99}
              step={1}
              value={targetText ?? String(Math.round(target * 100))}
              onChange={(e) => setTargetText(e.target.value)}
              onBlur={commitTarget}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitTarget();
              }}
              className="w-24 rounded border border-gray-300 bg-white p-2 text-sm"
            />
          )}
        </Field>
        <button
          type="button"
          onClick={run}
          disabled={!client || running}
          className="rounded-md bg-cyan-700 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-800 disabled:opacity-50"
        >
          {running ? "Working it out…" : result ? "Recalculate" : "Work it out"}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-red-700">Couldn't finish: {error}</p>}
      {s && (
        <div className={`mt-4 space-y-3 text-sm ${stale ? "opacity-50" : ""}`}>
          {stale && (
            <p className="text-xs font-medium text-amber-700">
              Your inputs changed since this was worked out. Recalculate to update.
            </p>
          )}
          <p className="text-gray-700">
            Right now {formatPct(s.currentSuccess, 0)} of simulated futures last
            to your plan age; the target is {formatPct(s.targetSuccess, 0)}.
            Each option below is on its own, with everything else unchanged.
          </p>
          <SolverRow
            title="Save more each month"
            body={
              s.extraMonthlySaving === null
                ? alreadyRetired
                  ? "Not possible: you're already retired, so there's nothing left to save."
                  : "Saving more alone can't reach the target (it would take over ₹50 lakh a month)."
                : s.extraMonthlySaving.value === 0
                  ? "No extra saving needed: you're already on target."
                  : `Invest ${formatCurrency(s.extraMonthlySaving.value)} more a month until retirement (invested like your current monthly savings) → ${formatPct(s.extraMonthlySaving.success, 0)}.`
            }
          />
          <SolverRow
            title="Retire at a different age"
            body={
              s.earliestRetirementAge === null
                ? "Retiring later alone can't reach the target before your plan age."
                : s.earliestRetirementAge.value < plannedRetirementAge
                  ? `You could retire as early as ${s.earliestRetirementAge.value} (planned ${plannedRetirementAge}) → ${formatPct(s.earliestRetirementAge.success, 0)}.`
                  : s.earliestRetirementAge.value === plannedRetirementAge
                    ? `Your planned age of ${plannedRetirementAge} is the earliest that meets the target.`
                    : `Retire at ${s.earliestRetirementAge.value} instead of ${plannedRetirementAge} → ${formatPct(s.earliestRetirementAge.success, 0)}.`
            }
          />
          <SolverRow
            title="Spend a different amount"
            body={
              s.maxSpend === null
                ? "Cutting spending alone can't reach the target: your one-time goals or healthcare costs are too large even with no other spending."
                : `Spend up to ${formatCurrency(s.maxSpend.value)} ${per} at today's prices (now ${formatCurrency(currentSpend)}) → ${formatPct(s.maxSpend.success, 0)}.`
            }
          />
          <p className="text-xs text-gray-500">
            Each try uses {s.iterations.toLocaleString("en-IN")} simulated futures, so these
            can differ from the main simulation by a point or two.
          </p>
        </div>
      )}
    </Section>
  );
}

function SolverRow({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded border border-cyan-100 bg-white p-3">
      <div className="text-xs font-semibold uppercase text-cyan-800">{title}</div>
      <div className="mt-1 text-gray-800">{body}</div>
    </div>
  );
}
