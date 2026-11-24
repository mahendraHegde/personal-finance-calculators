import { Plus } from "lucide-react";
import type { IncomeStream } from "../../types/retirement";
import type { RetirementCalculatorConfig } from "../../utils/storage";
import { formatCurrency, inputCls, patchById } from "./format";
import { HELP } from "./help";
import type { SetConfig } from "./params";
import {
  AddButton,
  Field,
  InfoTip,
  NumberField,
  OptionalNumberField,
  RemoveButton,
  Section,
  TextField,
} from "./ui";

const GROWTH_LABEL: Record<IncomeStream["growth"], string> = {
  inflation: "Rises with inflation",
  fixed: "Fixed amount",
  custom: "Grows at a set %",
};

export function IncomeSection({
  config,
  setConfig,
}: {
  config: RetirementCalculatorConfig;
  setConfig: SetConfig;
}) {
  const patch = (id: number, p: Partial<IncomeStream>) =>
    setConfig((c) => ({ ...c, incomeStreams: patchById(c.incomeStreams, id, p) }));
  const add = () =>
    setConfig((c) => ({
      ...c,
      incomeStreams: [
        ...c.incomeStreams,
        {
          id: c.nextIncomeStreamId,
          name: "Pension",
          monthlyAmount: 0,
          startAge: c.retirementAge,
          growth: "inflation",
          taxable: true,
        },
      ],
      nextIncomeStreamId: c.nextIncomeStreamId + 1,
    }));
  const remove = (id: number) =>
    setConfig((c) => ({ ...c, incomeStreams: c.incomeStreams.filter((s) => s.id !== id) }));

  return (
    <Section
      title="Income in Retirement"
      help={HELP.income}
      tone="bg-emerald-50 text-emerald-800"
      actions={
        <AddButton onClick={add} tone="bg-emerald-600 hover:bg-emerald-700">
          <Plus size={16} />
          Add Income
        </AddButton>
      }
    >
      {config.incomeStreams.length === 0 && (
        <p className="text-xs text-gray-600">
          No pension, annuity, rent or part-time income added. Add any you
          expect; even a small pension makes a big difference to how long
          your savings last.
        </p>
      )}
      {config.incomeStreams.map((s) => (
        <div key={s.id} className="mb-4 rounded-md border bg-white p-4">
          <div className="grid grid-cols-12 items-end gap-3">
            <TextField
              className="order-1 col-span-10 sm:order-none sm:col-span-4"
              label="Name"
              value={s.name}
              onChange={(v) => patch(s.id, { name: v })}
              placeholder="e.g., Pension, Rent"
            />
            <NumberField
              className="order-3 col-span-6 sm:order-none sm:col-span-3"
              label={`Per month (${formatCurrency(s.monthlyAmount)})`}
              help={HELP.incomeAmount}
              value={s.monthlyAmount}
              onChange={(v) => patch(s.id, { monthlyAmount: v })}
            />
            <NumberField
              className="order-4 col-span-3 sm:order-none sm:col-span-2"
              label="From age"
              help={HELP.incomeStart}
              value={s.startAge}
              onChange={(v) => patch(s.id, { startAge: v })}
            />
            <OptionalNumberField
              className="order-5 col-span-3 sm:order-none sm:col-span-2"
              label="Until age"
              help={HELP.incomeEnd}
              placeholder="life"
              value={s.endAge}
              onChange={(v) => patch(s.id, { endAge: v })}
            />
            <div className="order-2 col-span-2 sm:order-none sm:col-span-1">
              <RemoveButton onClick={() => remove(s.id)} name={s.name} />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-12 items-end gap-3 border-t border-gray-100 pt-3">
            <Field className="col-span-12 sm:col-span-5" label="How it changes" help={HELP.incomeGrowth}>
              {(id) => (
                <select
                  id={id}
                  value={s.growth}
                  onChange={(e) => patch(s.id, { growth: e.target.value as IncomeStream["growth"] })}
                  className={inputCls}
                >
                  {(Object.keys(GROWTH_LABEL) as IncomeStream["growth"][]).map((g) => (
                    <option key={g} value={g}>
                      {GROWTH_LABEL[g]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            {s.growth === "custom" && (
              <NumberField
                className="col-span-6 sm:col-span-3"
                label="Growth % a year"
                help={HELP.incomeGrowthRate}
                step="0.1"
                value={s.growthRate ?? 0}
                onChange={(v) => patch(s.id, { growthRate: v })}
              />
            )}
            <div className="col-span-6 flex items-center gap-2 pb-2 sm:col-span-4">
              <input
                id={`income-taxable-${s.id}`}
                type="checkbox"
                checked={Boolean(s.taxable)}
                onChange={(e) => patch(s.id, { taxable: e.target.checked })}
              />
              <label htmlFor={`income-taxable-${s.id}`} className="text-xs text-gray-700">
                Taxable
              </label>
              <InfoTip text={HELP.incomeTaxable} label="Taxable" />
            </div>
          </div>
          {s.endAge !== undefined && s.endAge <= s.startAge && (
            <p className="mt-2 text-xs font-medium text-amber-700">
              "Until age" has to be after "From age", so this income is never
              paid. Leave "Until age" empty if it lasts for life.
            </p>
          )}
          {s.startAge < config.retirementAge && (
            <p className="mt-2 text-xs text-gray-500">
              Counts from your retirement at {config.retirementAge}; before
              that it is assumed to fund your savings.
            </p>
          )}
        </div>
      ))}
    </Section>
  );
}
