import { Plus } from "lucide-react";
import type { SpendingPhase } from "../../types/retirement";
import type { RetirementCalculatorConfig } from "../../utils/storage";
import { formatCurrency, patchById } from "./format";
import { HELP } from "./help";
import type { SetConfig } from "./params";
import {
  AddButton,
  InfoTip,
  NumberField,
  OptionalNumberField,
  RemoveButton,
  Section,
} from "./ui";

// Common "go-go, slow-go, no-go" pattern.
const TYPICAL_PHASES = [
  { fromAge: 75, percentOfBase: 85 },
  { fromAge: 85, percentOfBase: 75 },
];

export function SpendingSection({
  config,
  setConfig,
}: {
  config: RetirementCalculatorConfig;
  setConfig: SetConfig;
}) {
  const patch = (id: number, p: Partial<SpendingPhase>) =>
    setConfig((c) => ({ ...c, spendingPhases: patchById(c.spendingPhases, id, p) }));
  const add = (phases: Omit<SpendingPhase, "id">[]) =>
    setConfig((c) => ({
      ...c,
      spendingPhases: [
        ...c.spendingPhases,
        ...phases.map((p, i) => ({ ...p, id: c.nextSpendingPhaseId + i })),
      ],
      nextSpendingPhaseId: c.nextSpendingPhaseId + phases.length,
    }));
  const remove = (id: number) =>
    setConfig((c) => ({ ...c, spendingPhases: c.spendingPhases.filter((p) => p.id !== id) }));
  const sorted = [...config.spendingPhases].sort((a, b) => a.fromAge - b.fromAge);
  const health = config.healthcare;

  return (
    <Section
      title="Spending Changes & Healthcare"
      help={HELP.phases}
      tone="bg-amber-50 text-amber-800"
      actions={
        <>
          {config.spendingPhases.length === 0 && (
            <button
              type="button"
              onClick={() => add(TYPICAL_PHASES)}
              className="rounded-md border border-amber-300 bg-white px-3 py-1 text-sm text-amber-800 hover:bg-amber-100"
            >
              Use typical pattern
            </button>
          )}
          <AddButton
            onClick={() =>
              add([
                {
                  fromAge: Math.max(config.retirementAge, ...config.spendingPhases.map((p) => p.fromAge)) + 10,
                  percentOfBase: 80,
                },
              ])
            }
            tone="bg-amber-600 hover:bg-amber-700"
          >
            <Plus size={16} />
            Add Change
          </AddButton>
        </>
      }
    >
      {sorted.length === 0 ? (
        <p className="mb-4 text-xs text-gray-600">
          Spending stays at 100% of what you entered for life. "Use typical
          pattern" sets 85% from 75 and 75% from 85.
        </p>
      ) : (
        <div className="mb-4 space-y-2">
          {sorted.map((p) => (
            <div key={p.id} className="grid grid-cols-12 items-end gap-3 rounded-md border bg-white p-3">
              <NumberField
                className="col-span-5"
                label="From age"
                help={HELP.phaseFrom}
                value={p.fromAge}
                onChange={(v) => patch(p.id, { fromAge: v })}
              />
              <NumberField
                className="col-span-5"
                label="% of base spending"
                help={HELP.phasePercent}
                min={0}
                value={p.percentOfBase}
                onChange={(v) => patch(p.id, { percentOfBase: v })}
              />
              <div className="col-span-2">
                <RemoveButton onClick={() => remove(p.id)} name={`change from age ${p.fromAge}`} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="rounded-md border bg-white p-3">
        <div className="mb-2 flex items-center text-sm font-medium text-gray-800">
          Healthcare
          <InfoTip text={HELP.healthcare} label="Healthcare" />
        </div>
        <div className="grid grid-cols-12 items-end gap-3">
          <NumberField
            className="col-span-12 sm:col-span-5"
            label={`Per month, today's ₹ (${formatCurrency(health.monthlyCost)})`}
            help={HELP.healthMonthly}
            value={health.monthlyCost}
            onChange={(v) => setConfig((c) => ({ ...c, healthcare: { ...c.healthcare, monthlyCost: v } }))}
          />
          <NumberField
            className="col-span-6 sm:col-span-3"
            label="Inflation %"
            help={HELP.healthInflation}
            step="0.5"
            value={health.inflation}
            onChange={(v) => setConfig((c) => ({ ...c, healthcare: { ...c.healthcare, inflation: v } }))}
          />
          <OptionalNumberField
            className="col-span-6 sm:col-span-4"
            label="From age"
            help={HELP.healthStart}
            placeholder={`${config.retirementAge} (retirement)`}
            value={health.startAge}
            onChange={(v) => setConfig((c) => ({ ...c, healthcare: { ...c.healthcare, startAge: v } }))}
          />
        </div>
      </div>
    </Section>
  );
}
