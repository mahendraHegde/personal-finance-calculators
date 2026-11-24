import {
  AlertCircle,
  Calculator,
  CheckCircle2,
  Download,
  PiggyBank,
  Plus,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import { Component, useEffect, useMemo, useState, type ErrorInfo, type ReactNode } from "react";
import type {
  InvestmentBucket,
  OneTimeExpense,
  PostRetirementBucket,
  TaxTreatment,
} from "../types/retirement";
import {
  calculateRetirement,
  DERISKED_VOLATILITY,
  MAX_INFLATION_PERSISTENCE,
} from "../utils/retirement";
import {
  getInitialRetirementConfig,
  normalizeConfig,
  saveRetirementConfig,
  type RetirementCalculatorConfig,
} from "../utils/storage";
import { PercentileBandChart } from "./retirement/PercentileBandChart";
import { IncomeSection } from "./retirement/IncomeSection";
import { PortfolioImportPanel, type ImportedBucket } from "./retirement/PortfolioImportPanel";
import { ScenarioPanel } from "./retirement/ScenarioPanel";
import { SolverPanel } from "./retirement/SolverPanel";
import { SpendingSection } from "./retirement/SpendingSection";
import { TaxSection } from "./retirement/TaxSection";
import {
  formatCurrency,
  formatPct,
  GOOD_SUCCESS_RATE,
  inputCls,
  optNum,
  patchById,
} from "./retirement/format";
import { HELP } from "./retirement/help";
import { toMcParams, toParams, type SetConfig } from "./retirement/params";
import {
  AddButton,
  BucketRow,
  Field,
  InfoTip,
  Metric,
  NumberField,
  OptionalNumberField,
  RemoveButton,
  Section,
  TextField,
} from "./retirement/ui";
import { useMonteCarlo, useWorkerClient } from "./retirement/workerClient";

const TAX_LABEL: Record<TaxTreatment, string> = {
  none: "No tax (return is after tax)",
  equity: "Equity (LTCG)",
  slabOnSale: "Debt fund (taxed on withdrawal)",
  slabYearly: "FD / interest (taxed yearly)",
};

const RetirementCalculator = () => {
  const [config, setConfigState] = useState<RetirementCalculatorConfig>(
    getInitialRetirementConfig,
  );
  const setConfig: SetConfig = setConfigState;
  const set = <K extends keyof RetirementCalculatorConfig>(
    key: K,
    value: RetirementCalculatorConfig[K],
  ) => setConfigState((c) => ({ ...c, [key]: value }));

  // Autosave (debounced) to this browser.
  const [saveFailed, setSaveFailed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSaveFailed(!saveRetirementConfig(config)), 400);
    return () => clearTimeout(t);
  }, [config]);

  const params = useMemo(() => toParams(config), [config]);
  const mcParams = useMemo(() => toMcParams(config), [config]);
  const calculations = useMemo(() => calculateRetirement(params), [params]);
  const client = useWorkerClient();
  const { result: monteCarlo, pending: mcPending, error: mcError } = useMonteCarlo(client, mcParams);

  const [showReal, setShowReal] = useState(true);
  const [importOpen, setImportOpen] = useState(false);

  // ---- List helpers ------------------------------------------------------
  const patchInvestment = (id: number, p: Partial<InvestmentBucket>) =>
    setConfig((c) => ({ ...c, investmentBuckets: patchById(c.investmentBuckets, id, p) }));
  const patchSaving = (id: number, p: Partial<InvestmentBucket>) =>
    setConfig((c) => ({ ...c, monthlySavingsBuckets: patchById(c.monthlySavingsBuckets, id, p) }));
  const patchExpense = (id: number, p: Partial<OneTimeExpense>) =>
    setConfig((c) => ({ ...c, oneTimeExpenses: patchById(c.oneTimeExpenses, id, p) }));
  const patchAllocation = (id: number, p: Partial<PostRetirementBucket>) =>
    setConfig((c) => ({ ...c, postRetirementBuckets: patchById(c.postRetirementBuckets, id, p) }));

  const importBuckets = (buckets: ImportedBucket[], mode: "replace" | "add") => {
    setConfig((c) => {
      const start = c.nextBucketId;
      const added = buckets.map((b, i) => ({
        id: start + i,
        name: b.name,
        amount: b.amount,
        return: b.return,
        volatility: b.volatility,
      }));
      return {
        ...c,
        investmentBuckets: mode === "replace" ? added : [...c.investmentBuckets, ...added],
        nextBucketId: start + added.length,
      };
    });
    setImportOpen(false);
  };

  // Sanitised values the engine actually used.
  const planAge = calculations.targetAge;
  const retireAge = calculations.retirementAge;
  const horizonAge = calculations.horizonAge;
  const toToday = (amount: number, index: number) => (index > 0 ? amount / index : amount);
  const corpusTodayAtRetirement = toToday(
    calculations.corpusAtRetirement,
    calculations.inflationIndexAtRetirement,
  );

  // ---- Input sanity notes (typed vs what the engine used) -----------------
  const inputNotes: string[] = [];
  const typed = (v: number) => (Number.isFinite(v) ? Math.round(v) : NaN);
  if (![config.currentAge, config.retirementAge, config.targetAge].every((a) => Number.isInteger(a))) {
    inputNotes.push("Ages are rounded to whole years.");
  }
  if (calculations.currentAge !== typed(config.currentAge)) {
    inputNotes.push(`Current age is taken as ${calculations.currentAge}.`);
  }
  if (calculations.retirementAge !== typed(config.retirementAge)) {
    inputNotes.push(
      calculations.retirementAge === calculations.currentAge &&
        typed(config.retirementAge) < calculations.currentAge
        ? `Retirement age is below your current age, so the plan treats you as retired from today (age ${calculations.currentAge}).`
        : `Retirement age is taken as ${calculations.retirementAge}.`,
    );
  }
  if (planAge !== typed(config.targetAge)) {
    inputNotes.push(
      typed(config.targetAge) <= calculations.retirementAge
        ? `"Plan until age" has to be after the retirement age (${calculations.retirementAge}), so ${planAge} is used.`
        : `"Plan until age" is capped at ${planAge}.`,
    );
  }
  if (calculations.yearsToRetirement === 0 && config.monthlySavingsBuckets.some((b) => b.amount > 0)) {
    inputNotes.push("You are already retired, so the monthly savings buckets are not used.");
  }
  const beyondHorizon = calculations.futureOneTimeExpenses.filter((e) => !e.withinHorizon);
  if (beyondHorizon.length > 0) {
    inputNotes.push(
      `${beyondHorizon.map((e) => e.name || "Unnamed expense").join(", ")} fall${
        beyondHorizon.length === 1 ? "s" : ""
      } after age ${horizonAge} and ${beyondHorizon.length === 1 ? "is" : "are"} left out of the plan.`,
    );
  }

  // ---- Headline verdict ------------------------------------------------
  const survivalAgeFloor = Math.floor(calculations.survivalAge);
  const deterministicLasts = calculations.corpusLastsBeyondHorizon
    ? `beyond age ${horizonAge}`
    : `until age ${survivalAgeFloor}`;
  const verdict: "good" | "fragile" | "fails" | "pending" = !calculations.lastsToTargetAge
    ? "fails"
    : !monteCarlo
      ? "pending"
      : monteCarlo.successRate >= GOOD_SUCCESS_RATE
        ? "good"
        : "fragile";
  const withdrawalRate = calculations.initialWithdrawalRate;
  const coverage = calculations.incomeCoverageAtDepletion;

  const finalCorpus = monteCarlo
    ? showReal
      ? { p10: monteCarlo.realP10FinalCorpus, p50: monteCarlo.realMedianFinalCorpus, p90: monteCarlo.realP90FinalCorpus }
      : { p10: monteCarlo.p10FinalCorpus, p50: monteCarlo.medianFinalCorpus, p90: monteCarlo.p90FinalCorpus }
    : null;

  return (
    <div className="mx-auto max-w-7xl bg-white p-4 sm:p-6">
      <div className="mb-8 text-center">
        <h1 className="mb-2 flex items-center justify-center gap-2 text-3xl font-bold text-gray-800">
          <Calculator className="text-blue-600" />
          Retirement Calculator
        </h1>
        <p className="text-gray-600">
          Plan your retirement with dynamic investment buckets, one-time
          expenses, retirement income, tax and Monte Carlo simulation
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-2">
        {/* ================= Inputs ================= */}
        <div className="min-w-0 space-y-6">
          <Section
            title="Basic Details"
            help={HELP.basics}
            tone="bg-blue-50 text-blue-800"
            actions={
              <span className={`flex items-center text-xs ${saveFailed ? "text-red-700" : "text-gray-500"}`}>
                {saveFailed ? "Not saved (browser storage blocked)" : "Saved automatically"}
                <InfoTip text={HELP.autosave} label="Saved automatically" />
              </span>
            }
          >
            <div className="grid grid-cols-2 gap-4">
              <NumberField
                label="Current Age"
                help={HELP.currentAge}
                labelClassName="text-sm font-medium text-gray-700"
                value={config.currentAge}
                onChange={(v) => set("currentAge", v)}
              />
              <NumberField
                label="Retirement Age"
                help={HELP.retirementAge}
                labelClassName="text-sm font-medium text-gray-700"
                value={config.retirementAge}
                onChange={(v) => set("retirementAge", v)}
              />
              <NumberField
                label="Expected Inflation (%)"
                help={HELP.inflation}
                labelClassName="text-sm font-medium text-gray-700"
                step="0.1"
                value={config.inflation}
                onChange={(v) => set("inflation", v)}
              />
              <Field label="Expense Type" help={HELP.expenseType} labelClassName="text-sm font-medium text-gray-700">
                {(id) => (
                  <select
                    id={id}
                    value={config.expenseType}
                    onChange={(e) => set("expenseType", e.target.value as "monthly" | "yearly")}
                    className={inputCls}
                  >
                    <option value="monthly">Monthly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                )}
              </Field>
              <NumberField
                label={`${config.expenseType === "monthly" ? "Monthly" : "Yearly"} spend in retirement, today's ₹ (${formatCurrency(config.monthlyExpenses)})`}
                help={HELP.spend}
                labelClassName="text-sm font-medium text-gray-700"
                value={config.monthlyExpenses}
                onChange={(v) => set("monthlyExpenses", v)}
              />
              <NumberField
                label="Plan Until Age"
                help={HELP.planAge}
                labelClassName="text-sm font-medium text-gray-700"
                value={config.targetAge}
                onChange={(v) => set("targetAge", v)}
              />
            </div>
            {inputNotes.length > 0 && (
              <ul className="mt-3 space-y-1 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                {inputNotes.map((note) => (
                  <li key={note} className="flex gap-1">
                    <AlertCircle size={14} className="mt-px shrink-0" />
                    {note}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {/* Existing investments */}
          <Section
            title="Existing Investment Buckets"
            help={HELP.existing}
            tone="bg-green-50 text-green-800"
            actions={
              <>
                <button
                  type="button"
                  onClick={() => setImportOpen((o) => !o)}
                  className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-green-600 bg-white px-3 py-1 text-sm text-green-800 hover:bg-green-100"
                >
                  <Download size={16} />
                  Import from Portfolio
                </button>
                <AddButton
                  onClick={() =>
                    setConfig((c) => ({
                      ...c,
                      investmentBuckets: [...c.investmentBuckets, { id: c.nextBucketId, name: "New Investment", amount: 0, return: 0 }],
                      nextBucketId: c.nextBucketId + 1,
                    }))
                  }
                  tone="bg-green-600 hover:bg-green-700"
                >
                  <Plus size={16} />
                  Add Bucket
                </AddButton>
              </>
            }
          >
            {importOpen && (
              <PortfolioImportPanel
                onImport={importBuckets}
                onClose={() => setImportOpen(false)}
                defaultTaxRate={config.tax.incomeTaxRate}
              />
            )}
            {config.investmentBuckets.map((bucket) => (
              <BucketRow
                key={bucket.id}
                nameLabel="Investment Name"
                name={bucket.name}
                namePlaceholder="e.g., Crypto, Gold, etc."
                onName={(v) => patchInvestment(bucket.id, { name: v })}
                middle={
                  <NumberField
                    label={`Amount (${formatCurrency(bucket.amount)})`}
                    help={HELP.amount}
                    value={bucket.amount}
                    onChange={(v) => patchInvestment(bucket.id, { amount: v })}
                  />
                }
                rate={bucket.return}
                onRate={(v) => patchInvestment(bucket.id, { return: v })}
                volatility={bucket.volatility}
                onVolatility={(v) => patchInvestment(bucket.id, { volatility: v })}
                defaultVolatility={config.portfolioVolatility}
                onRemove={() =>
                  setConfig((c) => ({ ...c, investmentBuckets: c.investmentBuckets.filter((b) => b.id !== bucket.id) }))
                }
                removeDisabled={config.investmentBuckets.length === 1}
              />
            ))}
          </Section>

          {/* Monthly savings */}
          <Section
            title="Monthly Savings Buckets"
            help={HELP.savings}
            tone="bg-indigo-50 text-indigo-800"
            actions={
              <AddButton
                onClick={() =>
                  setConfig((c) => ({
                    ...c,
                    monthlySavingsBuckets: [
                      ...c.monthlySavingsBuckets,
                      { id: c.nextSavingsBucketId, name: "New Savings", amount: 0, return: 0 },
                    ],
                    nextSavingsBucketId: c.nextSavingsBucketId + 1,
                  }))
                }
                tone="bg-indigo-600 hover:bg-indigo-700"
              >
                <Plus size={16} />
                Add Bucket
              </AddButton>
            }
          >
            {config.monthlySavingsBuckets.length === 0 && (
              <p className="text-xs text-gray-600">
                No monthly savings added. Add your SIPs, RDs or PF contributions.
              </p>
            )}
            {config.monthlySavingsBuckets.map((bucket) => {
              const linkedExpenses = config.oneTimeExpenses.filter((e) => e.linkedSavingsBucketId === bucket.id);
              const hasGlide =
                bucket.targetRate !== undefined && bucket.glideYears !== undefined && bucket.glideYears > 0;
              return (
                <BucketRow
                  key={bucket.id}
                  nameLabel="Bucket Name"
                  name={bucket.name}
                  namePlaceholder="e.g., SIP, Recurring Deposit, etc."
                  onName={(v) => patchSaving(bucket.id, { name: v })}
                  middle={
                    <NumberField
                      label={`Per month (${formatCurrency(bucket.amount)})`}
                      help={HELP.monthly}
                      value={bucket.amount}
                      onChange={(v) => patchSaving(bucket.id, { amount: v })}
                    />
                  }
                  rate={bucket.return}
                  onRate={(v) => patchSaving(bucket.id, { return: v })}
                  volatility={bucket.volatility}
                  onVolatility={(v) => patchSaving(bucket.id, { volatility: v })}
                  defaultVolatility={config.portfolioVolatility}
                  onRemove={() =>
                    setConfig((c) => ({
                      ...c,
                      monthlySavingsBuckets: c.monthlySavingsBuckets.filter((b) => b.id !== bucket.id),
                      // Unlink goals that pointed at this bucket.
                      oneTimeExpenses: c.oneTimeExpenses.map((e) =>
                        e.linkedSavingsBucketId === bucket.id ? { ...e, linkedSavingsBucketId: undefined } : e,
                      ),
                    }))
                  }
                >
                  <div className="mt-3 grid grid-cols-12 items-end gap-3 border-t border-gray-100 pt-3">
                    <OptionalNumberField
                      className="col-span-6 sm:col-span-4"
                      label="Yearly increase %"
                      help={HELP.stepUp}
                      step="1"
                      placeholder="0"
                      value={bucket.stepUpPct}
                      onChange={(v) => patchSaving(bucket.id, { stepUpPct: v })}
                    />
                    <div className="col-span-6 flex items-center gap-2 pb-2 sm:col-span-8">
                      <input
                        type="checkbox"
                        id={`glide-toggle-${bucket.id}`}
                        checked={hasGlide}
                        onChange={(e) =>
                          patchSaving(
                            bucket.id,
                            e.target.checked
                              ? {
                                  targetRate: bucket.targetRate ?? 6,
                                  glideYears: bucket.glideYears && bucket.glideYears > 0 ? bucket.glideYears : 3,
                                }
                              : { targetRate: undefined, glideYears: undefined },
                          )
                        }
                      />
                      <label htmlFor={`glide-toggle-${bucket.id}`} className="text-xs font-medium text-gray-700">
                        De-risk before goal
                      </label>
                      <InfoTip text={HELP.glide} label="De-risk before goal" />
                    </div>
                  </div>
                  {hasGlide && (
                    <div className="mt-2 grid grid-cols-2 items-end gap-3">
                      <OptionalNumberField
                        label="Target rate (%) near goal"
                        help={HELP.targetRate}
                        step="0.1"
                        value={bucket.targetRate}
                        onChange={(v) => patchSaving(bucket.id, { targetRate: v })}
                      />
                      <OptionalNumberField
                        label="Glide window (years)"
                        help={HELP.glideYears}
                        step="1"
                        min={1}
                        value={bucket.glideYears}
                        onChange={(v) =>
                          patchSaving(bucket.id, { glideYears: v === undefined ? undefined : Math.max(1, Math.floor(v)) })
                        }
                      />
                    </div>
                  )}
                  {hasGlide && linkedExpenses.length === 0 && (
                    <p className="mt-1 text-xs text-amber-700">
                      Link a one-time expense (below) for this glide to kick in.
                      Without a linked goal, the glide has no effect.
                    </p>
                  )}
                  {hasGlide && linkedExpenses.length > 0 && (
                    <p className="mt-1 text-xs text-gray-500">
                      Over the last {bucket.glideYears} year(s) before the next
                      pending goal ({linkedExpenses.map((e) => e.name).join(", ")}),
                      the money moves into a safer asset: the return slides from{" "}
                      {bucket.return}% to {bucket.targetRate}% and the Monte Carlo
                      volatility drops toward {DERISKED_VOLATILITY}%.
                    </p>
                  )}
                </BucketRow>
              );
            })}
          </Section>

          {/* One-time expenses */}
          <Section
            title="One-Time Expenses"
            help={HELP.oneTime}
            tone="bg-orange-50 text-orange-800"
            actions={
              <AddButton
                onClick={() =>
                  setConfig((c) => ({
                    ...c,
                    oneTimeExpenses: [
                      ...c.oneTimeExpenses,
                      { id: c.nextExpenseId, name: "New Expense", yearsFromNow: 1, currentCost: 0, inflationRate: 6 },
                    ],
                    nextExpenseId: c.nextExpenseId + 1,
                  }))
                }
                tone="bg-orange-600 hover:bg-orange-700"
              >
                <Plus size={16} />
                Add Expense
              </AddButton>
            }
          >
            {config.oneTimeExpenses.map((expense) => {
              const future = calculations.futureOneTimeExpenses.find((e) => e.id === expense.id);
              const earmarked =
                expense.linkedSavingsBucketId !== undefined &&
                future !== undefined &&
                future.withinHorizon &&
                future.yearsFromNow > calculations.yearsToRetirement;
              return (
                <div key={expense.id} className="mb-4 rounded-md border bg-white p-4">
                  <div className="grid grid-cols-12 items-end gap-3">
                    <TextField
                      className="order-1 col-span-10 sm:order-none sm:col-span-3"
                      label="Expense Name"
                      value={expense.name}
                      onChange={(v) => patchExpense(expense.id, { name: v })}
                      placeholder="e.g., Car, Education"
                    />
                    <NumberField
                      className="order-3 col-span-4 sm:order-none sm:col-span-2"
                      label="Years from now"
                      help={HELP.yearsFromNow}
                      value={expense.yearsFromNow}
                      onChange={(v) => patchExpense(expense.id, { yearsFromNow: v })}
                    />
                    <NumberField
                      className="order-4 col-span-5 sm:order-none sm:col-span-3"
                      label={`Cost today (${formatCurrency(expense.currentCost)})`}
                      help={HELP.costToday}
                      value={expense.currentCost}
                      onChange={(v) => patchExpense(expense.id, { currentCost: v })}
                    />
                    <NumberField
                      className="order-5 col-span-3 sm:order-none sm:col-span-3"
                      label="Inflation %"
                      help={HELP.expenseInflation}
                      step="0.1"
                      value={expense.inflationRate}
                      onChange={(v) => patchExpense(expense.id, { inflationRate: v })}
                    />
                    <div className="order-2 col-span-2 sm:order-none sm:col-span-1">
                      <RemoveButton
                        onClick={() =>
                          setConfig((c) => ({ ...c, oneTimeExpenses: c.oneTimeExpenses.filter((e) => e.id !== expense.id) }))
                        }
                        name={expense.name}
                      />
                    </div>
                  </div>
                  {future && (
                    <p className="mt-2 text-xs text-gray-500">
                      Due at age {future.ageWhenDue}, costing about {formatCurrency(future.futureValue)} then.
                    </p>
                  )}
                  <div className="mt-3 border-t border-gray-100 pt-3">
                    <div className="flex items-center gap-2">
                      <label htmlFor={`fund-${expense.id}`} className="whitespace-nowrap text-xs text-gray-600">
                        Funded by:
                      </label>
                      <InfoTip text={HELP.fundedBy} label="Funded by" />
                      <select
                        id={`fund-${expense.id}`}
                        value={expense.linkedSavingsBucketId ?? ""}
                        onChange={(ev) => patchExpense(expense.id, { linkedSavingsBucketId: optNum(ev.target.value) })}
                        disabled={config.monthlySavingsBuckets.length === 0}
                        className="min-w-0 flex-1 rounded border border-gray-300 bg-white p-2 text-sm disabled:bg-gray-100 disabled:text-gray-400"
                      >
                        <option value="">(general corpus, pro-rata)</option>
                        {config.monthlySavingsBuckets.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name || `Bucket #${b.id}`}: {formatCurrency(b.amount)}/mo @ {b.return}%
                          </option>
                        ))}
                      </select>
                    </div>
                    {config.monthlySavingsBuckets.length === 0 ? (
                      <p className="mt-1 text-xs text-gray-500">
                        Tip: add a Monthly Savings Bucket above to earmark funds for
                        this expense (sinking fund). Without a link, the cost is
                        pulled pro-rata from your existing investments.
                      </p>
                    ) : expense.linkedSavingsBucketId !== undefined && future !== undefined && !future.withinHorizon ? (
                      <p className="mt-1 text-xs text-amber-700">
                        This expense falls after age {horizonAge}, so it is left out
                        of the plan and doesn't hold any money back for it.
                      </p>
                    ) : earmarked ? (
                      <p className="mt-1 text-xs text-gray-500">
                        This expense is after retirement. On your retirement day,
                        only what it needs (its cost discounted at the SIP's rate)
                        is set aside from the SIP and keeps growing until the
                        expense is paid; the rest joins your retirement money.
                        The set-aside money only pays living costs if everything
                        else runs out first.
                      </p>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </Section>

          <IncomeSection config={config} setConfig={setConfig} />
          <SpendingSection config={config} setConfig={setConfig} />

          {/* Post-retirement allocation */}
          <Section
            title="Post-Retirement Allocation"
            help={HELP.allocationSection}
            tone="bg-teal-50 text-teal-800"
            actions={
              <AddButton
                onClick={() =>
                  setConfig((c) => ({
                    ...c,
                    postRetirementBuckets: [
                      ...c.postRetirementBuckets,
                      { id: c.nextPostRetirementBucketId, name: "New Bucket", allocationPct: 0, return: 8 },
                    ],
                    nextPostRetirementBucketId: c.nextPostRetirementBucketId + 1,
                  }))
                }
                tone="bg-teal-600 hover:bg-teal-700"
              >
                <Plus size={16} />
                Add Bucket
              </AddButton>
            }
          >
            <p className="mb-4 text-xs text-gray-600">
              How your corpus is reallocated at retirement. Allocations are
              normalised, so exact 100% is not required, but recommended.
              {calculations.earmarkedAtRetirement > 0 && (
                <>
                  {" "}
                  <span className="font-medium text-teal-700">
                    Money set aside for goals ({formatCurrency(calculations.earmarkedAtRetirement)})
                    is not included here.
                  </span>
                </>
              )}
            </p>
            {(() => {
              // Shares come from the engine's own split (it clamps negative
              // percentages and normalises), so labels match what is modelled.
              const amountById = new Map(calculations.postRetirementAllocation.map((a) => [a.id, a.amount]));
              const totalPct = config.postRetirementBuckets.reduce(
                (s, b) => s + (Number.isFinite(b.allocationPct) ? Math.max(0, b.allocationPct) : 0),
                0,
              );
              return (
                <>
                  {config.postRetirementBuckets.map((bucket) => (
                    <BucketRow
                      key={bucket.id}
                      nameLabel="Bucket Name"
                      name={bucket.name}
                      namePlaceholder="e.g., Cash, Debt, Equity"
                      onName={(v) => patchAllocation(bucket.id, { name: v })}
                      middle={
                        <NumberField
                          label={`Allocation % (${formatCurrency(totalPct > 0 ? (amountById.get(bucket.id) ?? 0) : 0)})`}
                          help={HELP.allocation}
                          step="1"
                          min={0}
                          value={bucket.allocationPct}
                          onChange={(v) => patchAllocation(bucket.id, { allocationPct: v })}
                        />
                      }
                      rate={bucket.return}
                      onRate={(v) => patchAllocation(bucket.id, { return: v })}
                      rateHelp={HELP.returnPreTax}
                      volatilityHelp={HELP.volatilityRetirement}
                      volatility={bucket.volatility}
                      onVolatility={(v) => patchAllocation(bucket.id, { volatility: v })}
                      defaultVolatility={config.portfolioVolatility}
                      onRemove={() =>
                        setConfig((c) => ({
                          ...c,
                          postRetirementBuckets: c.postRetirementBuckets.filter((b) => b.id !== bucket.id),
                        }))
                      }
                    >
                      <Field className="mt-3 border-t border-gray-100 pt-3" label="Tax treatment" help={HELP.taxTreatment}>
                        {(id) => (
                          <select
                            id={id}
                            value={bucket.taxTreatment ?? "none"}
                            onChange={(e) => patchAllocation(bucket.id, { taxTreatment: e.target.value as TaxTreatment })}
                            className={inputCls}
                          >
                            {(Object.keys(TAX_LABEL) as TaxTreatment[]).map((t) => (
                              <option key={t} value={t}>
                                {TAX_LABEL[t]}
                              </option>
                            ))}
                          </select>
                        )}
                      </Field>
                    </BucketRow>
                  ))}
                  <div
                    className={`flex items-center justify-between gap-2 rounded p-2 text-sm font-medium ${
                      Math.abs(totalPct - 100) < 0.01
                        ? "bg-green-100 text-green-800"
                        : totalPct === 0
                          ? "bg-yellow-100 text-yellow-800"
                          : "bg-amber-100 text-amber-800"
                    }`}
                  >
                    <span>
                      Total allocation: {totalPct.toFixed(1)}%
                      {totalPct === 0 && (
                        <> (falls back to your pre-retirement mix at {calculations.weightedReturn.toFixed(1)}%)</>
                      )}
                      {Math.abs(totalPct - 100) > 0.01 && totalPct > 0 && <> (normalised to 100% internally)</>}
                    </span>
                    <span>{formatCurrency(calculations.mainCorpusAtRetirement)}</span>
                  </div>
                </>
              );
            })()}
          </Section>

          <TaxSection config={config} setConfig={setConfig} />

          {/* Monte Carlo settings */}
          <Section
            title={
              <span className="flex items-center gap-2">
                <Sparkles size={20} />
                Monte Carlo Settings
              </span>
            }
            help={HELP.mcSettings}
            helpLabel="Monte Carlo Settings"
            tone="bg-pink-50 text-pink-800"
          >
            <div className="grid grid-cols-2 gap-4">
              <NumberField
                label="Default volatility (% std dev)"
                help={HELP.defaultVolatility}
                labelClassName="text-sm font-medium text-gray-700"
                step="0.5"
                min={0}
                value={config.portfolioVolatility}
                onChange={(v) => set("portfolioVolatility", v)}
              />
              <NumberField
                label="Inflation volatility (% std dev)"
                help={HELP.inflationVolatility}
                labelClassName="text-sm font-medium text-gray-700"
                step="0.1"
                min={0}
                value={config.inflationVolatility}
                onChange={(v) => set("inflationVolatility", v)}
              />
              <NumberField
                label={`Inflation persistence (0 to ${MAX_INFLATION_PERSISTENCE})`}
                help={HELP.inflationPersistence}
                labelClassName="text-sm font-medium text-gray-700"
                step="0.05"
                min={0}
                max={MAX_INFLATION_PERSISTENCE}
                value={config.inflationPersistence}
                onChange={(v) => set("inflationPersistence", Math.min(MAX_INFLATION_PERSISTENCE, Math.max(0, v)))}
              />
              <NumberField
                label="Iterations"
                help={HELP.iterations}
                labelClassName="text-sm font-medium text-gray-700"
                step="500"
                min={100}
                max={20000}
                value={config.monteCarloIterations}
                onChange={(v) => set("monteCarloIterations", v)}
              />
              <div className="col-span-2 flex items-center gap-2">
                <input
                  id="fat-tails"
                  type="checkbox"
                  checked={config.fatTails}
                  onChange={(e) => set("fatTails", e.target.checked)}
                />
                <label htmlFor="fat-tails" className="text-sm text-gray-700">
                  Include occasional crash and boom years (fat tails)
                </label>
                <InfoTip text={HELP.fatTails} label="Fat tails" />
              </div>
            </div>
          </Section>
        </div>

        {/* ================= Results ================= */}
        <div className="min-w-0 space-y-6">
          {/* Headline verdict */}
          <div
            className={`rounded-lg border p-4 ${
              verdict === "good"
                ? "border-green-200 bg-green-50"
                : verdict === "fails"
                  ? "border-red-200 bg-red-50"
                  : "border-amber-200 bg-amber-50"
            }`}
          >
            <div
              className={`mb-1 flex items-center gap-2 font-semibold ${
                verdict === "good" ? "text-green-800" : verdict === "fails" ? "text-red-800" : "text-amber-800"
              }`}
            >
              {verdict === "good" ? <CheckCircle2 size={20} /> : <AlertCircle size={20} />}
              {verdict === "good"
                ? `On track to age ${planAge}`
                : verdict === "fragile"
                  ? "Works on average, but fragile"
                  : verdict === "pending"
                    ? "Works on the expected path; simulating…"
                    : `Money runs out at age ${survivalAgeFloor}`}
              <InfoTip text={HELP.verdict} label="Plan verdict" />
            </div>
            <p className="text-sm text-gray-700">
              If every year delivers exactly the returns you entered, your money
              lasts <strong>{deterministicLasts}</strong>.
              {monteCarlo && (
                <>
                  {" "}
                  Across {monteCarlo.iterations.toLocaleString("en-IN")} simulated markets it lasts to
                  age {planAge} in <strong>{formatPct(monteCarlo.successRate, 0)}</strong> of cases.
                </>
              )}
              {verdict === "fragile" && monteCarlo && (
                <>
                  {" "}
                  A poor run of returns (before or early in retirement), or higher
                  inflation, breaks the plan in the other {formatPct(1 - monteCarlo.successRate, 0)}.
                </>
              )}
              {verdict === "fails" && ` That is ${planAge - survivalAgeFloor} year(s) short of your plan age.`}
              {verdict === "fails" && coverage !== undefined && coverage > 0 && (
                <> After that, your income still covers about {formatPct(coverage, 0)} of your spending.</>
              )}
            </p>
          </div>

          {/* Summary cards */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 p-4 text-white">
              <div className="mb-2 flex items-center gap-2">
                <PiggyBank size={20} />
                <span className="text-sm opacity-90">Corpus at Retirement</span>
                <span className="text-white/80">
                  <InfoTip text={HELP.corpusAtRetirement} label="Corpus at Retirement" />
                </span>
              </div>
              <div className="text-2xl font-bold">{formatCurrency(calculations.corpusAtRetirement)}</div>
              <div className="mt-1 text-xs opacity-90">
                ≈ {formatCurrency(corpusTodayAtRetirement)} in today's money, at age {retireAge}
              </div>
              {calculations.earmarkedAtRetirement > 0 && (
                <div className="mt-2 border-t border-white/20 pt-2 text-xs opacity-90">
                  <div>Set aside for goals: {formatCurrency(calculations.earmarkedAtRetirement)}</div>
                  <div>Available for retirement: {formatCurrency(calculations.mainCorpusAtRetirement)}</div>
                </div>
              )}
            </div>
            <div className="rounded-lg bg-gradient-to-r from-green-500 to-green-600 p-4 text-white">
              <div className="mb-2 flex items-center gap-2">
                <TrendingUp size={20} />
                <span className="text-sm opacity-90">Return in retirement</span>
                <span className="text-white/80">
                  <InfoTip text={HELP.returnInRetirement} label="Return in retirement" />
                </span>
              </div>
              <div className="text-2xl font-bold">{calculations.postRetirementReturn.toFixed(1)}%</div>
              <div className="mt-1 text-xs opacity-90">
                Real (after {calculations.inflation}% inflation): {calculations.postRetirementRealReturn.toFixed(1)}%
              </div>
              <div className="mt-1 flex items-center text-xs opacity-80">
                Mix just before retirement: {calculations.weightedReturn.toFixed(1)}% (real{" "}
                {calculations.realReturn.toFixed(1)}%)
                <InfoTip text={HELP.mixBeforeRetirement} label="Mix just before retirement" />
              </div>
            </div>
          </div>

          {/* Key metrics */}
          <div className="rounded-lg bg-yellow-50 p-4 sm:p-6">
            <h2 className="mb-4 flex items-center text-xl font-semibold text-yellow-800">
              Key Metrics (expected path)
              <InfoTip text={HELP.keyMetrics} label="Key Metrics" />
            </h2>
            <div className="space-y-3">
              <Metric label="Annual spend (today):" help={HELP.spendToday}>
                {formatCurrency(calculations.annualExpenses)}
              </Metric>
              <Metric label={`Annual spend at retirement (age ${retireAge}):`} help={HELP.spendAtRetirement}>
                {formatCurrency(calculations.annualExpensesAtRetirement)}
              </Metric>
              {calculations.annualIncomeAtRetirement > 0 && (
                <Metric label="Annual income at retirement:" help={HELP.incomeAtRetirement}>
                  {formatCurrency(calculations.annualIncomeAtRetirement)}
                </Metric>
              )}
              <Metric
                label="First-year withdrawal rate:"
                help={HELP.withdrawalRate}
                valueClass={
                  withdrawalRate <= 0.035 ? "text-green-600" : withdrawalRate <= 0.045 ? "text-amber-600" : "text-red-600"
                }
              >
                {formatPct(withdrawalRate)}
              </Metric>
              <Metric label="Corpus lasts after retirement:" help={HELP.lastsYears} valueClass="text-blue-600">
                {calculations.corpusLastsBeyondHorizon
                  ? `${horizonAge - retireAge}+ years`
                  : `${calculations.yearsAfterRetirement.toFixed(1)} years`}
              </Metric>
              <Metric
                label="Money lasts until age:"
                help={HELP.lastsAge}
                valueClass={calculations.lastsToTargetAge ? "text-purple-600" : "text-red-600"}
              >
                {calculations.corpusLastsBeyondHorizon ? `${horizonAge}+` : survivalAgeFloor}
              </Metric>
            </div>
          </div>

          {/* Monte Carlo results */}
          <div className={`rounded-lg bg-pink-50 p-4 transition-opacity sm:p-6 ${mcPending && monteCarlo ? "opacity-60" : ""}`}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-xl font-semibold text-pink-800">
                <Sparkles size={20} />
                Monte Carlo Simulation
                <InfoTip text={HELP.mcSettings} label="Monte Carlo Simulation" />
                {mcPending && <span className="text-xs font-normal text-gray-500">updating…</span>}
              </h2>
              <div className="flex items-center">
                <div className="flex overflow-hidden rounded-md border border-pink-200 text-xs" role="group" aria-label="Show amounts in">
                  <button
                    type="button"
                    onClick={() => setShowReal(true)}
                    aria-pressed={showReal}
                    className={`px-2 py-1 ${showReal ? "bg-pink-600 text-white" : "bg-white text-gray-700"}`}
                  >
                    Today's ₹
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowReal(false)}
                    aria-pressed={!showReal}
                    className={`px-2 py-1 ${!showReal ? "bg-pink-600 text-white" : "bg-white text-gray-700"}`}
                  >
                    Future ₹
                  </button>
                </div>
                <InfoTip text={HELP.todayVsFuture} label="Today's ₹ or Future ₹" />
              </div>
            </div>
            {mcError && (
              <p className="mb-2 text-sm text-red-700">
                The latest simulation failed ({mcError}); the numbers below are from your previous inputs.
              </p>
            )}
            {!monteCarlo ? (
              <p className="text-sm text-gray-600">Simulating {mcParams.iterations.toLocaleString("en-IN")} futures…</p>
            ) : (
              <>
                <div className="mb-4 grid grid-cols-2 gap-4">
                  <div className="rounded bg-white p-3">
                    <div className="flex items-center text-xs uppercase text-gray-500">
                      Success Rate
                      <InfoTip text={HELP.successRate} label="Success rate" />
                    </div>
                    <div
                      className={`text-2xl font-bold ${
                        monteCarlo.successRate >= GOOD_SUCCESS_RATE
                          ? "text-green-600"
                          : monteCarlo.successRate >= 0.6
                            ? "text-yellow-600"
                            : "text-red-600"
                      }`}
                    >
                      {formatPct(monteCarlo.successRate)}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      Paths that fund living costs to age {planAge} ({monteCarlo.iterations.toLocaleString("en-IN")} runs)
                    </div>
                  </div>
                  <div className="rounded bg-white p-3">
                    <div className="flex items-center text-xs uppercase text-gray-500">
                      Bad case lasts until
                      <InfoTip text={HELP.badCase} label="Bad case" />
                    </div>
                    <div className="text-2xl font-bold text-blue-600">
                      {monteCarlo.p10DepletionAge >= monteCarlo.targetAge
                        ? `${monteCarlo.targetAge}+`
                        : Math.floor(monteCarlo.p10DepletionAge)}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">Age by which the worst 10% of paths run out</div>
                  </div>
                </div>
                {finalCorpus && (
                  <>
                    <div className="mb-1 flex items-center text-xs font-medium text-gray-600">
                      Left at age {planAge} ({showReal ? "today's ₹" : "future ₹"})
                      <InfoTip text={HELP.finalCorpus} label="Left at plan age" />
                    </div>
                    <div className="mb-4 grid grid-cols-3 gap-2">
                      {(
                        [
                          ["P10", finalCorpus.p10, "text-red-600", "Pessimistic"],
                          ["Median", finalCorpus.p50, "text-gray-800", "Typical"],
                          ["P90", finalCorpus.p90, "text-green-600", "Optimistic"],
                        ] as const
                      ).map(([label, value, cls, hint]) => (
                        <div key={label} className="rounded bg-white p-2">
                          <div className="text-[11px] uppercase text-gray-500">{label}</div>
                          <div className={`text-base font-semibold ${cls}`}>{formatCurrency(value)}</div>
                          <div className="text-[11px] text-gray-500">{hint}</div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                <PercentileBandChart
                  percentiles={showReal ? monteCarlo.realPercentiles : monteCarlo.percentiles}
                  deterministic={[
                    { age: calculations.currentAge, value: calculations.startingCorpus },
                    ...calculations.yearlyData
                      .filter((d) => d.age <= monteCarlo.targetAge)
                      .map((d) => ({ age: d.age, value: showReal ? toToday(d.corpus, d.inflationIndex) : d.corpus })),
                  ]}
                  retirementAge={retireAge}
                  unitLabel={showReal ? "today's ₹" : "future ₹"}
                />
              </>
            )}
          </div>

          <SolverPanel
            client={client}
            params={mcParams}
            target={config.solverTargetSuccess}
            onTarget={(t) => set("solverTargetSuccess", t)}
            plannedRetirementAge={retireAge}
            alreadyRetired={calculations.yearsToRetirement === 0}
            currentSpend={config.monthlyExpenses}
            expenseType={config.expenseType}
          />

          <ScenarioPanel
            config={config}
            onLoad={(c) => setConfigState(normalizeConfig(c))}
            client={client}
          />

          {/* Goal funding */}
          {calculations.expenseFundings.length > 0 && (
            <div className="rounded-lg bg-red-50 p-4 sm:p-6">
              <h2 className="mb-4 flex items-center text-xl font-semibold text-red-800">
                Future One-Time Expenses
                <InfoTip text={HELP.goalsResult} label="Future One-Time Expenses" />
              </h2>
              <div className="max-h-72 space-y-3 overflow-y-auto">
                {calculations.expenseFundings.map((f) => {
                  const fullyLinked = f.drainedFromLinked > 0 && f.drainedFromMain === 0 && f.shortfall === 0;
                  const partial = f.drainedFromLinked > 0 && (f.drainedFromMain > 0 || f.shortfall > 0);
                  const unlinked = f.drainedFromLinked === 0;
                  const status = f.afterDepletion
                    ? "unpaid"
                    : f.shortfall > 0
                      ? "shortfall"
                      : fullyLinked
                        ? "fully-linked"
                        : partial
                          ? "partial"
                          : "unlinked";
                  const statusColor =
                    status === "unpaid" || status === "shortfall"
                      ? "border-red-400 bg-red-100"
                      : status === "fully-linked"
                        ? "border-green-300 bg-green-50"
                        : status === "partial"
                          ? "border-amber-300 bg-amber-50"
                          : "border-gray-200 bg-white";
                  return (
                    <div key={`${f.expenseId}-${f.yearsFromNow}`} className={`rounded border p-3 ${statusColor}`}>
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="font-medium text-gray-800">
                          {f.expenseName} <span className="text-xs text-gray-500">(Age {f.ageWhenDue})</span>
                        </span>
                        <span className="font-semibold text-red-600">{formatCurrency(f.futureValue)}</span>
                      </div>
                      <div className="mt-1 space-y-0.5 text-xs text-gray-600">
                        {f.afterDepletion && (
                          <div className="font-medium text-red-700">
                            Not paid: the money runs out at age {survivalAgeFloor}, before this is due.
                          </div>
                        )}
                        {f.drainedFromLinked > 0 && (
                          <div>
                            From SIP / set-aside money:{" "}
                            <span className="font-medium text-green-700">{formatCurrency(f.drainedFromLinked)}</span>
                            {f.linkedBalanceBefore !== undefined && (
                              <span className="text-gray-500"> (it had {formatCurrency(f.linkedBalanceBefore)})</span>
                            )}
                          </div>
                        )}
                        {f.drainedFromMain > 0 && (
                          <div>
                            From main corpus:{" "}
                            <span className={`font-medium ${unlinked ? "text-gray-700" : "text-amber-700"}`}>
                              {formatCurrency(f.drainedFromMain)}
                            </span>
                          </div>
                        )}
                        {f.shortfall > 0 && !f.afterDepletion && (
                          <div>
                            <span className="font-medium text-red-700">Shortfall: {formatCurrency(f.shortfall)}</span>{" "}
                            <span className="text-gray-500">(your savings could not cover this goal in full)</span>
                          </div>
                        )}
                        {f.surplusRolledOver !== undefined && f.surplusRolledOver > 0 && (
                          <div className="font-medium text-emerald-700">
                            Surplus {formatCurrency(f.surplusRolledOver)} rolls into your retirement corpus.
                          </div>
                        )}
                        {fullyLinked && f.surplusRolledOver === undefined && (
                          <div className="text-xs italic text-green-700">Fully funded by the linked SIP.</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Warnings */}
          {calculations.postRetirementRealReturn < 0 && (
            <div className="rounded-lg border border-red-200 bg-red-50 p-4">
              <div className="mb-2 flex items-center gap-2 text-red-700">
                <AlertCircle size={20} />
                <span className="font-semibold">Warning: Negative Real Return in Retirement</span>
              </div>
              <p className="text-sm text-red-600">
                Your retirement allocation earns {calculations.postRetirementReturn.toFixed(1)}%, below{" "}
                {calculations.inflation}% inflation, so the corpus loses buying power every year even
                before withdrawals.
              </p>
            </div>
          )}
          {monteCarlo && monteCarlo.successRate < 0.7 && (
            <div className="rounded-lg border border-orange-200 bg-orange-50 p-4">
              <div className="mb-2 flex items-center gap-2 text-orange-700">
                <AlertCircle size={20} />
                <span className="font-semibold">Low Success Probability</span>
              </div>
              <p className="text-sm text-orange-600">
                Only {formatPct(monteCarlo.successRate, 0)} of simulated paths fund expenses through age{" "}
                {planAge}. "What would it take?" above shows how much to change to fix it.
              </p>
            </div>
          )}

          {/* Portfolio allocation today */}
          <div className="rounded-lg bg-purple-50 p-4 sm:p-6">
            <h2 className="mb-4 flex items-center text-xl font-semibold text-purple-800">
              Portfolio Allocation (today)
              <InfoTip text={HELP.portfolioToday} label="Portfolio Allocation (today)" />
            </h2>
            <div className="space-y-2">
              {(() => {
                const total = config.investmentBuckets.reduce((s, b) => s + (Number.isFinite(b.amount) ? b.amount : 0), 0);
                return config.investmentBuckets.map((bucket) => (
                  <div key={bucket.id} className="flex items-center justify-between gap-2">
                    <span className="text-sm text-gray-700">{bucket.name}:</span>
                    <span className="text-sm font-medium">
                      {(total > 0 ? (bucket.amount / total) * 100 : 0).toFixed(1)}% ({formatCurrency(bucket.amount)})
                    </span>
                  </div>
                ));
              })()}
            </div>
          </div>

          {/* Year-by-year */}
          <div className="rounded-lg bg-gray-50 p-4 sm:p-6">
            <h2 className="mb-1 flex items-center text-xl font-semibold text-gray-800">
              Year-by-Year Projection
              <InfoTip text={HELP.yearByYear} label="Year-by-Year Projection" />
            </h2>
            <p className="mb-4 text-xs text-gray-500">
              Expected path. Amounts in future ₹, with today's value in brackets.
            </p>
            <div className="max-h-80 space-y-2 overflow-y-auto">
              {calculations.yearlyData.map((data, index) => {
                const isDepletionYear =
                  !calculations.corpusLastsBeyondHorizon && index === calculations.yearlyData.length - 1;
                return (
                  <div key={data.year} className="text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="text-gray-600">
                        Age {data.age}{" "}
                        <span className={`ml-1 text-xs ${data.isRetired ? "text-purple-600" : "text-blue-600"}`}>
                          ({data.isRetired ? "retired" : "working"})
                        </span>
                        :
                      </span>
                      <span className="text-right font-medium">
                        {formatCurrency(data.corpus)}{" "}
                        <span className="text-xs font-normal text-gray-500">
                          ({formatCurrency(toToday(data.corpus, data.inflationIndex))})
                        </span>
                      </span>
                    </div>
                    <div className="ml-4 flex flex-wrap gap-x-2 text-xs text-gray-500">
                      {data.isRetired ? (
                        <span>
                          Spent: {formatCurrency(data.regularExpenses)}
                          {data.healthcareExpenses > 0 && <> (health {formatCurrency(data.healthcareExpenses)})</>}
                          {data.livingCostsFromEarmarked > 0 && (
                            <span className="text-amber-700">
                              {" "}
                              ({formatCurrency(data.livingCostsFromEarmarked)} from goal savings)
                            </span>
                          )}
                        </span>
                      ) : (
                        <span>Saved: {formatCurrency(data.contributions)}</span>
                      )}
                      {data.incomeReceived > 0 && <span>Income: {formatCurrency(data.incomeReceived)}</span>}
                      <span>Growth: {formatCurrency(data.growth)}</span>
                      {data.taxPaid > 0 && <span>Tax: {formatCurrency(data.taxPaid)}</span>}
                      {data.oneTimeExpenses > 0 && (
                        <span className="text-red-600">
                          One-time: {formatCurrency(data.oneTimeExpenses)}
                          {data.oneTimeItems.length > 0 && <> ({data.oneTimeItems.map((item) => item.name).join(", ")})</>}
                        </span>
                      )}
                    </div>
                    {isDepletionYear && (
                      <div className="ml-4 text-xs font-medium text-red-700">
                        Money runs out during this year (age {calculations.survivalAge.toFixed(1)}).
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// Keeps a crash in the calculator (for example from hand-edited saved data)
// inside this tab, so it can never take the Portfolio tab down with it.
class CalculatorErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Retirement calculator crashed:", error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-xl rounded-lg bg-white p-6 text-center">
        <h2 className="mb-2 text-lg font-semibold text-red-700">The retirement calculator hit a problem</h2>
        <p className="mb-4 text-sm text-gray-600">
          This is usually caused by damaged saved inputs. Resetting replaces
          your inputs with the defaults (your saved plans are kept).
        </p>
        <button
          type="button"
          onClick={() => {
            saveRetirementConfig(normalizeConfig({}));
            this.setState({ error: null });
          }}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Reset calculator inputs
        </button>
      </div>
    );
  }
}

const RetirementCalculatorWithBoundary = () => (
  <CalculatorErrorBoundary>
    <RetirementCalculator />
  </CalculatorErrorBoundary>
);

export default RetirementCalculatorWithBoundary;
