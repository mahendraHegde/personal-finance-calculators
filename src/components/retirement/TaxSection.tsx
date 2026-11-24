import type { WithdrawalStrategy } from "../../types/retirement";
import type { RetirementCalculatorConfig } from "../../utils/storage";
import { inputCls } from "./format";
import { HELP } from "./help";
import type { SetConfig } from "./params";
import { Field, NumberField, Section } from "./ui";

const STRATEGY_LABEL: Record<WithdrawalStrategy, string> = {
  proRata: "Proportional from all buckets",
  rebalance: "Proportional, rebalance yearly",
  buckets: "Bucket strategy (lowest volatility first)",
};

export function TaxSection({
  config,
  setConfig,
}: {
  config: RetirementCalculatorConfig;
  setConfig: SetConfig;
}) {
  const setTax = (p: Partial<RetirementCalculatorConfig["tax"]>) =>
    setConfig((c) => ({ ...c, tax: { ...c.tax, ...p } }));
  const allocated = config.postRetirementBuckets.some(
    (b) => Number.isFinite(b.allocationPct) && b.allocationPct > 0,
  );
  const anyTaxed =
    allocated &&
    config.postRetirementBuckets.some(
      (b) => b.allocationPct > 0 && b.taxTreatment && b.taxTreatment !== "none",
    );
  const anyTaxableIncome = config.incomeStreams.some((s) => s.taxable);
  return (
    <Section title="Tax & Withdrawals" help={HELP.taxSection} tone="bg-slate-100 text-slate-800">
      <div className="grid grid-cols-12 items-end gap-3">
        <NumberField
          className="col-span-12 sm:col-span-4"
          label="Your income-tax rate %"
          help={HELP.incomeTaxRate}
          step="1"
          min={0}
          max={100}
          value={config.tax.incomeTaxRate}
          onChange={(v) => setTax({ incomeTaxRate: v })}
        />
        <NumberField
          className="col-span-6 sm:col-span-4"
          label="Equity LTCG tax %"
          help={HELP.ltcgRate}
          step="0.5"
          min={0}
          value={config.tax.ltcgRate}
          onChange={(v) => setTax({ ltcgRate: v })}
        />
        <NumberField
          className="col-span-6 sm:col-span-4"
          label="Tax-free equity gain / yr"
          help={HELP.ltcgExemption}
          step="5000"
          min={0}
          value={config.tax.ltcgExemption}
          onChange={(v) => setTax({ ltcgExemption: v })}
        />
      </div>
      {!allocated && (
        <p className="mt-2 text-xs text-amber-700">
          No post-retirement allocation is set, so your savings stay in your
          pre-retirement mix and no tax is worked out on withdrawals. Set an
          allocation below to use tax treatments.
        </p>
      )}
      {allocated && !anyTaxed && !anyTaxableIncome && (
        <p className="mt-2 text-xs text-gray-600">
          No tax is being calculated: every post-retirement bucket is set to
          "No tax" and no income is marked taxable. Pick a tax treatment on a
          bucket below to have tax worked out on withdrawals.
        </p>
      )}
      <div className="mt-4 grid grid-cols-12 items-end gap-3 border-t border-slate-200 pt-4">
        <Field className="col-span-12 sm:col-span-8" label="Where spending comes from" help={HELP.strategy}>
          {(id) => (
            <select
              id={id}
              value={config.withdrawalStrategy}
              onChange={(e) =>
                setConfig((c) => ({ ...c, withdrawalStrategy: e.target.value as WithdrawalStrategy }))
              }
              className={inputCls}
            >
              {(Object.keys(STRATEGY_LABEL) as WithdrawalStrategy[]).map((s) => (
                <option key={s} value={s}>
                  {STRATEGY_LABEL[s]}
                </option>
              ))}
            </select>
          )}
        </Field>
        {config.withdrawalStrategy === "buckets" && (
          <NumberField
            className="col-span-12 sm:col-span-4"
            label="Years in safe bucket"
            help={HELP.cashBuffer}
            step="0.5"
            min={0}
            value={config.cashBufferYears}
            onChange={(v) => setConfig((c) => ({ ...c, cashBufferYears: v }))}
          />
        )}
      </div>
      {config.withdrawalStrategy === "buckets" && config.postRetirementBuckets.length < 2 && (
        <p className="mt-2 text-xs text-amber-700">
          The bucket strategy needs at least two post-retirement buckets
          (a safe one and a growth one).
        </p>
      )}
    </Section>
  );
}
