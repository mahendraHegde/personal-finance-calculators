import {
  AlertCircle,
  Calculator,
  PiggyBank,
  Plus,
  Sparkles,
  Trash2,
  TrendingUp,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  FutureOneTimeExpense,
  InvestmentBucket,
  MonteCarloResult,
  OneTimeExpense,
  PostRetirementBucket,
  RetirementCalculationsResult,
  YearlyProjection,
} from "../types/retirement";
import { runMonteCarloSimulation } from "../utils/monteCarlo";
import { calculateRetirement } from "../utils/retirement";
import {
  getInitialRetirementConfig,
  saveRetirementConfig,
  type RetirementCalculatorConfig,
} from "../utils/storage";

const RetirementCalculator = () => {
  const initialConfig: RetirementCalculatorConfig =
    getInitialRetirementConfig();

  const [currentAge, setCurrentAge] = useState<number>(
    initialConfig.currentAge,
  );
  const [retirementAge, setRetirementAge] = useState<number>(
    initialConfig.retirementAge || 60,
  );
  const [inflation, setInflation] = useState<number>(initialConfig.inflation);
  const [monthlyExpenses, setMonthlyExpenses] = useState<number>(
    initialConfig.monthlyExpenses,
  );
  const [expenseType, setExpenseType] = useState<"monthly" | "yearly">(
    initialConfig.expenseType,
  );

  const [investmentBuckets, setInvestmentBuckets] = useState<
    InvestmentBucket[]
  >(initialConfig.investmentBuckets);

  const [monthlySavingsBuckets, setMonthlySavingsBuckets] = useState<
    InvestmentBucket[]
  >(initialConfig.monthlySavingsBuckets || []);

  const [oneTimeExpenses, setOneTimeExpenses] = useState<OneTimeExpense[]>(
    initialConfig.oneTimeExpenses,
  );

  const [postRetirementBuckets, setPostRetirementBuckets] = useState<
    PostRetirementBucket[]
  >(initialConfig.postRetirementBuckets ?? []);

  const [nextBucketId, setNextBucketId] = useState<number>(
    initialConfig.nextBucketId,
  );
  const [nextSavingsBucketId, setNextSavingsBucketId] = useState<number>(
    initialConfig.nextSavingsBucketId || 1,
  );
  const [nextExpenseId, setNextExpenseId] = useState<number>(
    initialConfig.nextExpenseId,
  );
  const [nextPostRetirementBucketId, setNextPostRetirementBucketId] =
    useState<number>(initialConfig.nextPostRetirementBucketId ?? 1);

  // Monte Carlo controls
  const [targetAge, setTargetAge] = useState<number>(
    initialConfig.targetAge ?? 90,
  );
  const [portfolioVolatility, setPortfolioVolatility] = useState<number>(
    initialConfig.portfolioVolatility ?? 12,
  );
  const [inflationVolatility, setInflationVolatility] = useState<number>(
    initialConfig.inflationVolatility ?? 1.5,
  );
  const [monteCarloIterations, setMonteCarloIterations] = useState<number>(
    initialConfig.monteCarloIterations ?? 2000,
  );

  const [saveStatus, setSaveStatus] = useState<"idle" | "saved">("idle");

  const handleSave = () => {
    saveRetirementConfig({
      currentAge,
      retirementAge,
      inflation,
      monthlyExpenses,
      expenseType,
      investmentBuckets,
      monthlySavingsBuckets,
      oneTimeExpenses,
      postRetirementBuckets,
      nextBucketId,
      nextSavingsBucketId,
      nextExpenseId,
      nextPostRetirementBucketId,
      targetAge,
      portfolioVolatility,
      inflationVolatility,
      monteCarloIterations,
    });
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus("idle"), 2000);
  };

  const SaveButton = () => (
    <div className="flex items-center gap-2">
      <button
        onClick={handleSave}
        className="px-4 cursor-pointer py-1 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
        type="button"
      >
        Save
      </button>
      {saveStatus === "saved" && (
        <span className="text-green-600 text-sm font-medium">Saved!</span>
      )}
    </div>
  );

  const addMonthlySavingsBucket = () => {
    setMonthlySavingsBuckets((prev) => [
      ...prev,
      { id: nextSavingsBucketId, name: "New Savings", amount: 0, return: 0 },
    ]);
    setNextSavingsBucketId((prev) => prev + 1);
  };

  const updateMonthlySavingsBucket = (
    id: number,
    field: keyof InvestmentBucket,
    value: string | number | undefined,
  ) => {
    setMonthlySavingsBuckets((buckets) =>
      buckets.map((bucket) =>
        bucket.id === id ? { ...bucket, [field]: value } : bucket,
      ),
    );
  };

  const removeMonthlySavingsBucket = (id: number) => {
    setMonthlySavingsBuckets((buckets) =>
      buckets.filter((bucket) => bucket.id !== id),
    );
    // Scrub any one-time expense that was linked to this bucket so the
    // dropdown shows "general corpus" instead of leaving a dangling reference.
    setOneTimeExpenses((expenses) =>
      expenses.map((e) =>
        e.linkedSavingsBucketId === id
          ? { ...e, linkedSavingsBucketId: undefined }
          : e,
      ),
    );
  };

  const addInvestmentBucket = () => {
    setInvestmentBuckets((prev) => [
      ...prev,
      { id: nextBucketId, name: "New Investment", amount: 0, return: 0 },
    ]);
    setNextBucketId((prev) => prev + 1);
  };

  const updateInvestmentBucket = (
    id: number,
    field: keyof InvestmentBucket,
    value: string | number,
  ) => {
    setInvestmentBuckets((buckets) =>
      buckets.map((bucket) =>
        bucket.id === id ? { ...bucket, [field]: value } : bucket,
      ),
    );
  };

  const removeInvestmentBucket = (id: number) => {
    setInvestmentBuckets((buckets) =>
      buckets.filter((bucket) => bucket.id !== id),
    );
  };

  const addOneTimeExpense = () => {
    setOneTimeExpenses((prev) => [
      ...prev,
      {
        id: nextExpenseId,
        name: "New Expense",
        yearsFromNow: 1,
        currentCost: 0,
        inflationRate: 6,
      },
    ]);
    setNextExpenseId((prev) => prev + 1);
  };

  const updateOneTimeExpense = (
    id: number,
    field: keyof OneTimeExpense,
    value: string | number | undefined,
  ) => {
    setOneTimeExpenses((expenses) =>
      expenses.map((expense) =>
        expense.id === id ? { ...expense, [field]: value } : expense,
      ),
    );
  };

  const removeOneTimeExpense = (id: number) => {
    setOneTimeExpenses((expenses) =>
      expenses.filter((expense) => expense.id !== id),
    );
  };

  const addPostRetirementBucket = () => {
    setPostRetirementBuckets((prev) => [
      ...prev,
      {
        id: nextPostRetirementBucketId,
        name: "New Bucket",
        allocationPct: 0,
        return: 8,
      },
    ]);
    setNextPostRetirementBucketId((prev) => prev + 1);
  };

  const updatePostRetirementBucket = (
    id: number,
    field: keyof PostRetirementBucket,
    value: string | number,
  ) => {
    setPostRetirementBuckets((buckets) =>
      buckets.map((b) => (b.id === id ? { ...b, [field]: value } : b)),
    );
  };

  const removePostRetirementBucket = (id: number) => {
    setPostRetirementBuckets((buckets) => buckets.filter((b) => b.id !== id));
  };

  const calculations: RetirementCalculationsResult = useMemo(
    () =>
      calculateRetirement({
        currentAge,
        retirementAge,
        inflation,
        monthlyExpenses,
        expenseType,
        investmentBuckets,
        monthlySavingsBuckets,
        oneTimeExpenses,
        postRetirementBuckets,
        targetAge,
      }),
    [
      currentAge,
      retirementAge,
      inflation,
      monthlyExpenses,
      expenseType,
      investmentBuckets,
      monthlySavingsBuckets,
      oneTimeExpenses,
      postRetirementBuckets,
      targetAge,
    ],
  );

  // Monte Carlo — recomputes when any of the same inputs change. With the
  // default 2000 iterations this finishes in well under 100ms in practice,
  // so running on every input change is acceptable.
  const monteCarlo: MonteCarloResult = useMemo(
    () =>
      runMonteCarloSimulation({
        currentAge,
        retirementAge,
        inflation,
        monthlyExpenses,
        expenseType,
        investmentBuckets,
        monthlySavingsBuckets,
        oneTimeExpenses,
        postRetirementBuckets,
        targetAge,
        portfolioVolatility,
        inflationVolatility,
        iterations: Math.max(100, Math.min(20000, monteCarloIterations)),
        seed: 42,
      }),
    [
      currentAge,
      retirementAge,
      inflation,
      monthlyExpenses,
      expenseType,
      investmentBuckets,
      monthlySavingsBuckets,
      oneTimeExpenses,
      postRetirementBuckets,
      targetAge,
      portfolioVolatility,
      inflationVolatility,
      monteCarloIterations,
    ],
  );

  const formatCurrency = (amount: number) => {
    if (amount >= 10000000) {
      return `₹${(amount / 10000000).toFixed(1)} Cr`;
    } else if (amount >= 100000) {
      return `₹${(amount / 100000).toFixed(1)} L`;
    }
    return `₹${Math.round(amount).toLocaleString("en-IN")}`;
  };

  return (
    <div className="max-w-7xl mx-auto p-6 bg-white">
      <div className="text-center mb-8">
        <h1 className="text-3xl font-bold text-gray-800 mb-2 flex items-center justify-center gap-2">
          <Calculator className="text-blue-600" />
          Retirement Calculator
        </h1>
        <p className="text-gray-600">
          Plan your retirement with dynamic investment buckets, one-time
          expenses, and Monte Carlo simulation
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-8">
        {/* Input Section */}
        <div className="space-y-6">
          {/* Basic Details */}
          <div className="bg-blue-50 p-6 rounded-lg">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-blue-800">
                Basic Details
              </h2>
              <SaveButton />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Current Age
                </label>
                <input
                  type="number"
                  value={currentAge}
                  onChange={(e) => setCurrentAge(Number(e.target.value))}
                  className="w-full p-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Retirement Age
                </label>
                <input
                  type="number"
                  value={retirementAge}
                  onChange={(e) => setRetirementAge(Number(e.target.value))}
                  className="w-full p-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Expected Inflation (%)
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={inflation}
                  onChange={(e) => setInflation(Number(e.target.value))}
                  className="w-full p-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Expense Type
                </label>
                <select
                  value={expenseType}
                  onChange={(e) =>
                    setExpenseType(e.target.value as "monthly" | "yearly")
                  }
                  className="w-full p-2 border border-gray-300 rounded-md"
                >
                  <option value="monthly">Monthly</option>
                  <option value="yearly">Yearly</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Expected {expenseType === "monthly" ? "Monthly" : "Yearly"}{" "}
                  Expenses ({formatCurrency(monthlyExpenses)})
                </label>
                <input
                  type="number"
                  value={monthlyExpenses}
                  onChange={(e) => setMonthlyExpenses(Number(e.target.value))}
                  className="w-full p-2 border border-gray-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Plan Until Age
                </label>
                <input
                  type="number"
                  value={targetAge}
                  onChange={(e) => setTargetAge(Number(e.target.value))}
                  className="w-full p-2 border border-gray-300 rounded-md"
                />
              </div>
            </div>
          </div>

          {/* Existing Investment Buckets */}
          <div className="bg-green-50 p-6 rounded-lg">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-green-800">
                Existing Investment Buckets
              </h2>
              <button
                onClick={addInvestmentBucket}
                className="flex items-center gap-1 px-3 py-1 bg-green-600 text-white rounded-md hover:bg-green-700 text-sm"
              >
                <Plus size={16} />
                Add Bucket
              </button>
            </div>

            {investmentBuckets.map((bucket) => (
              <div
                key={bucket.id}
                className="mb-4 p-4 bg-white rounded-md border"
              >
                <div className="grid grid-cols-12 gap-3 items-center">
                  <div className="col-span-4">
                    <label className="block text-xs text-gray-600 mb-1">
                      Investment Name
                    </label>
                    <input
                      type="text"
                      value={bucket.name}
                      onChange={(e) =>
                        updateInvestmentBucket(
                          bucket.id,
                          "name",
                          e.target.value,
                        )
                      }
                      className="w-full p-2 text-sm border border-gray-300 rounded"
                      placeholder="e.g., Crypto, Gold, etc."
                    />
                  </div>
                  <div className="col-span-3">
                    <label className="block text-xs text-gray-600 mb-1">
                      Amount ({formatCurrency(bucket.amount)})
                    </label>
                    <input
                      type="number"
                      value={bucket.amount}
                      onChange={(e) =>
                        updateInvestmentBucket(
                          bucket.id,
                          "amount",
                          Number(e.target.value),
                        )
                      }
                      className="w-full p-2 text-sm border border-gray-300 rounded"
                    />
                  </div>
                  <div className="col-span-3">
                    <label className="block text-xs text-gray-600 mb-1">
                      Post-tax Return (%)
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      value={bucket.return}
                      onChange={(e) =>
                        updateInvestmentBucket(
                          bucket.id,
                          "return",
                          Number(e.target.value),
                        )
                      }
                      className="w-full p-2 text-sm border border-gray-300 rounded"
                    />
                  </div>
                  <div className="col-span-2">
                    <button
                      onClick={() => removeInvestmentBucket(bucket.id)}
                      className="w-full p-2 text-red-600 hover:bg-red-50 rounded"
                      disabled={investmentBuckets.length === 1}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Monthly Savings Buckets */}
          <div className="bg-indigo-50 p-6 rounded-lg">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-indigo-800">
                Monthly Savings Buckets
              </h2>
              <button
                onClick={addMonthlySavingsBucket}
                className="flex items-center gap-1 px-3 py-1 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 text-sm"
              >
                <Plus size={16} />
                Add Bucket
              </button>
            </div>
            {monthlySavingsBuckets.map((bucket) => {
              const linkedExpenses = oneTimeExpenses.filter(
                (e) => e.linkedSavingsBucketId === bucket.id,
              );
              const hasGlide =
                bucket.targetRate !== undefined &&
                bucket.glideYears !== undefined &&
                bucket.glideYears > 0;
              return (
                <div
                  key={bucket.id}
                  className="mb-4 p-4 bg-white rounded-md border"
                >
                  <div className="grid grid-cols-12 gap-3 items-center">
                    <div className="col-span-4">
                      <label className="block text-xs text-gray-600 mb-1">
                        Bucket Name
                      </label>
                      <input
                        type="text"
                        value={bucket.name}
                        onChange={(e) =>
                          updateMonthlySavingsBucket(
                            bucket.id,
                            "name",
                            e.target.value,
                          )
                        }
                        className="w-full p-2 text-sm border border-gray-300 rounded"
                        placeholder="e.g., SIP, Recurring Deposit, etc."
                      />
                    </div>
                    <div className="col-span-3">
                      <label className="block text-xs text-gray-600 mb-1">
                        Monthly Amount: {formatCurrency(bucket.amount)}
                      </label>
                      <input
                        type="number"
                        value={bucket.amount}
                        onChange={(e) =>
                          updateMonthlySavingsBucket(
                            bucket.id,
                            "amount",
                            Number(e.target.value),
                          )
                        }
                        className="w-full p-2 text-sm border border-gray-300 rounded"
                      />
                    </div>
                    <div className="col-span-3">
                      <label className="block text-xs text-gray-600 mb-1">
                        Expected Return (%)
                      </label>
                      <input
                        type="number"
                        step="0.1"
                        value={bucket.return}
                        onChange={(e) =>
                          updateMonthlySavingsBucket(
                            bucket.id,
                            "return",
                            Number(e.target.value),
                          )
                        }
                        className="w-full p-2 text-sm border border-gray-300 rounded"
                      />
                    </div>
                    <div className="col-span-2">
                      <button
                        onClick={() => removeMonthlySavingsBucket(bucket.id)}
                        className="w-full p-2 text-red-600 hover:bg-red-50 rounded"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>

                  {/* De-risk-before-goal sub-row */}
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <div className="flex items-center gap-2 mb-2">
                      <input
                        type="checkbox"
                        id={`glide-toggle-${bucket.id}`}
                        checked={hasGlide}
                        onChange={(e) => {
                          if (e.target.checked) {
                            // Enable: prefill safer default rate (6%) and a
                            // 3-year glide window if not already configured.
                            updateMonthlySavingsBucket(
                              bucket.id,
                              "targetRate",
                              bucket.targetRate ?? 6,
                            );
                            updateMonthlySavingsBucket(
                              bucket.id,
                              "glideYears",
                              bucket.glideYears && bucket.glideYears > 0
                                ? bucket.glideYears
                                : 3,
                            );
                          } else {
                            updateMonthlySavingsBucket(
                              bucket.id,
                              "targetRate",
                              undefined,
                            );
                            updateMonthlySavingsBucket(
                              bucket.id,
                              "glideYears",
                              undefined,
                            );
                          }
                        }}
                      />
                      <label
                        htmlFor={`glide-toggle-${bucket.id}`}
                        className="text-xs text-gray-700 font-medium"
                      >
                        De-risk before goal
                      </label>
                    </div>
                    {hasGlide && (
                      <div className="grid grid-cols-12 gap-3 items-center">
                        <div className="col-span-5">
                          <label className="block text-xs text-gray-600 mb-1">
                            Target rate (%) near goal
                          </label>
                          <input
                            type="number"
                            step="0.1"
                            value={bucket.targetRate ?? ""}
                            onChange={(e) =>
                              updateMonthlySavingsBucket(
                                bucket.id,
                                "targetRate",
                                e.target.value === ""
                                  ? undefined
                                  : Number(e.target.value),
                              )
                            }
                            className="w-full p-2 text-sm border border-gray-300 rounded"
                          />
                        </div>
                        <div className="col-span-5">
                          <label className="block text-xs text-gray-600 mb-1">
                            Glide window (years)
                          </label>
                          <input
                            type="number"
                            step="1"
                            min={1}
                            value={bucket.glideYears ?? ""}
                            onChange={(e) =>
                              updateMonthlySavingsBucket(
                                bucket.id,
                                "glideYears",
                                e.target.value === ""
                                  ? undefined
                                  : Math.max(1, Math.floor(Number(e.target.value))),
                              )
                            }
                            className="w-full p-2 text-sm border border-gray-300 rounded"
                          />
                        </div>
                      </div>
                    )}
                    {hasGlide && linkedExpenses.length === 0 && (
                      <p className="text-xs text-amber-700 mt-1">
                        Link a one-time expense (below) for this glide to
                        kick in. Without a linked goal, the glide has no
                        effect.
                      </p>
                    )}
                    {hasGlide && linkedExpenses.length > 0 && (
                      <p className="text-xs text-gray-500 mt-1">
                        Rate transitions from {bucket.return}% → {bucket.targetRate}%
                        over the last {bucket.glideYears} year(s) before the
                        next pending goal (
                        {linkedExpenses
                          .map((e) => e.name)
                          .join(", ")}
                        ).
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* One-Time Expenses */}
          <div className="bg-orange-50 p-6 rounded-lg">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-orange-800">
                One-Time Expenses
              </h2>
              <button
                onClick={addOneTimeExpense}
                className="flex items-center gap-1 px-3 py-1 bg-orange-600 text-white rounded-md hover:bg-orange-700 text-sm"
              >
                <Plus size={16} />
                Add Expense
              </button>
            </div>

            {oneTimeExpenses.map((expense) => (
              <div
                key={expense.id}
                className="mb-4 p-4 bg-white rounded-md border"
              >
                <div className="grid grid-cols-12 gap-3 items-center">
                  <div className="col-span-3">
                    <label className="block text-xs text-gray-600 mb-1">
                      Expense Name
                    </label>
                    <input
                      type="text"
                      value={expense.name}
                      onChange={(e) =>
                        updateOneTimeExpense(
                          expense.id,
                          "name",
                          e.target.value,
                        )
                      }
                      className="w-full p-2 text-sm border border-gray-300 rounded"
                      placeholder="e.g., Car, Education"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-600 mb-1">
                      Years from Now
                    </label>
                    <input
                      type="number"
                      value={expense.yearsFromNow}
                      onChange={(e) =>
                        updateOneTimeExpense(
                          expense.id,
                          "yearsFromNow",
                          Number(e.target.value),
                        )
                      }
                      className="w-full p-2 text-sm border border-gray-300 rounded"
                    />
                  </div>
                  <div className="col-span-3">
                    <label className="block text-xs text-gray-600 mb-1">
                      Current Cost ({formatCurrency(expense.currentCost)})
                    </label>
                    <input
                      type="number"
                      value={expense.currentCost}
                      onChange={(e) =>
                        updateOneTimeExpense(
                          expense.id,
                          "currentCost",
                          Number(e.target.value),
                        )
                      }
                      className="w-full p-2 text-sm border border-gray-300 rounded"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-gray-600 mb-1">
                      Inflation (%)
                    </label>
                    <input
                      type="number"
                      step="0.1"
                      value={expense.inflationRate}
                      onChange={(e) =>
                        updateOneTimeExpense(
                          expense.id,
                          "inflationRate",
                          Number(e.target.value),
                        )
                      }
                      className="w-full p-2 text-sm border border-gray-300 rounded"
                    />
                  </div>
                  <div className="col-span-2">
                    <button
                      onClick={() => removeOneTimeExpense(expense.id)}
                      className="w-full p-2 text-red-600 hover:bg-red-50 rounded"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>

                <div className="mt-3 pt-3 border-t border-gray-100">
                  <div className="flex items-center gap-2">
                    <label className="text-xs text-gray-600 whitespace-nowrap">
                      Funded by:
                    </label>
                    <select
                      value={expense.linkedSavingsBucketId ?? ""}
                      onChange={(ev) =>
                        updateOneTimeExpense(
                          expense.id,
                          "linkedSavingsBucketId",
                          ev.target.value === ""
                            ? undefined
                            : Number(ev.target.value),
                        )
                      }
                      disabled={monthlySavingsBuckets.length === 0}
                      className="flex-1 p-2 text-sm border border-gray-300 rounded bg-white disabled:bg-gray-100 disabled:text-gray-400"
                    >
                      <option value="">(general corpus, pro-rata)</option>
                      {monthlySavingsBuckets.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.name || `Bucket #${b.id}`} —{" "}
                          {formatCurrency(b.amount)}/mo @ {b.return}%
                        </option>
                      ))}
                    </select>
                  </div>
                  {monthlySavingsBuckets.length === 0 ? (
                    <p className="text-xs text-gray-500 mt-1">
                      Tip: add a Monthly Savings Bucket above to earmark
                      funds for this expense (sinking fund). Without a
                      link, the cost is pulled pro-rata from your existing
                      investments.
                    </p>
                  ) : expense.linkedSavingsBucketId !== undefined &&
                    expense.yearsFromNow >
                      Math.max(0, retirementAge - currentAge) ? (
                    <p className="text-xs text-gray-500 mt-1">
                      This expense is post-retirement. Contributions stop
                      at retirement, but the SIP balance is held aside and
                      keeps compounding at its rate until this expense
                      fires; any leftover then rolls into the corpus.
                    </p>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {/* Post-Retirement Allocation */}
          <div className="bg-teal-50 p-6 rounded-lg">
            <div className="flex justify-between items-center mb-2">
              <h2 className="text-xl font-semibold text-teal-800">
                Post-Retirement Allocation
              </h2>
              <button
                onClick={addPostRetirementBucket}
                className="flex items-center gap-1 px-3 py-1 bg-teal-600 text-white rounded-md hover:bg-teal-700 text-sm"
              >
                <Plus size={16} />
                Add Bucket
              </button>
            </div>
            <p className="text-xs text-gray-600 mb-4">
              How your corpus is reallocated at retirement. Each bucket
              compounds at its own rate during decumulation; expenses are
              pulled pro-rata. Allocations are normalised — exact 100% is
              not required, but recommended.
              {calculations.earmarkedAtRetirement > 0 && (
                <>
                  {" "}
                  <span className="text-teal-700 font-medium">
                    Earmarked SIPs ({formatCurrency(
                      calculations.earmarkedAtRetirement,
                    )}
                    ) are held aside for their linked goals and not
                    included here.
                  </span>
                </>
              )}
            </p>
            {(() => {
              const totalPct = postRetirementBuckets.reduce(
                (s, b) => s + (Number.isFinite(b.allocationPct) ? b.allocationPct : 0),
                0,
              );
              const mainCorpus = calculations.mainCorpusAtRetirement;
              const norm = totalPct > 0 ? totalPct : 1;
              return (
                <>
                  {postRetirementBuckets.map((bucket) => {
                    const share =
                      totalPct > 0
                        ? (bucket.allocationPct / norm) * mainCorpus
                        : 0;
                    return (
                      <div
                        key={bucket.id}
                        className="mb-4 p-4 bg-white rounded-md border"
                      >
                        <div className="grid grid-cols-12 gap-3 items-center">
                          <div className="col-span-4">
                            <label className="block text-xs text-gray-600 mb-1">
                              Bucket Name
                            </label>
                            <input
                              type="text"
                              value={bucket.name}
                              onChange={(e) =>
                                updatePostRetirementBucket(
                                  bucket.id,
                                  "name",
                                  e.target.value,
                                )
                              }
                              className="w-full p-2 text-sm border border-gray-300 rounded"
                              placeholder="e.g., Cash, Debt, Equity"
                            />
                          </div>
                          <div className="col-span-3">
                            <label className="block text-xs text-gray-600 mb-1">
                              Allocation (%) — {formatCurrency(share)}
                            </label>
                            <input
                              type="number"
                              step="1"
                              min={0}
                              value={bucket.allocationPct}
                              onChange={(e) =>
                                updatePostRetirementBucket(
                                  bucket.id,
                                  "allocationPct",
                                  Number(e.target.value),
                                )
                              }
                              className="w-full p-2 text-sm border border-gray-300 rounded"
                            />
                          </div>
                          <div className="col-span-3">
                            <label className="block text-xs text-gray-600 mb-1">
                              Expected Return (%)
                            </label>
                            <input
                              type="number"
                              step="0.1"
                              value={bucket.return}
                              onChange={(e) =>
                                updatePostRetirementBucket(
                                  bucket.id,
                                  "return",
                                  Number(e.target.value),
                                )
                              }
                              className="w-full p-2 text-sm border border-gray-300 rounded"
                            />
                          </div>
                          <div className="col-span-2">
                            <button
                              onClick={() =>
                                removePostRetirementBucket(bucket.id)
                              }
                              className="w-full p-2 text-red-600 hover:bg-red-50 rounded"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div
                    className={`flex justify-between items-center p-2 rounded text-sm font-medium ${
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
                        <> — falls back to single aggregated corpus</>
                      )}
                      {Math.abs(totalPct - 100) > 0.01 && totalPct > 0 && (
                        <> — normalised to 100% internally</>
                      )}
                    </span>
                    <span>{formatCurrency(mainCorpus)}</span>
                  </div>
                </>
              );
            })()}
          </div>

          {/* Monte Carlo controls */}
          <div className="bg-pink-50 p-6 rounded-lg">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-semibold text-pink-800 flex items-center gap-2">
                <Sparkles size={20} />
                Monte Carlo Settings
              </h2>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Portfolio Volatility (% std dev)
                </label>
                <input
                  type="number"
                  step="0.5"
                  value={portfolioVolatility}
                  onChange={(e) =>
                    setPortfolioVolatility(Number(e.target.value))
                  }
                  className="w-full p-2 border border-gray-300 rounded-md"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Typical: 5% (debt) to 18% (equity-heavy)
                </p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Inflation Volatility (% std dev)
                </label>
                <input
                  type="number"
                  step="0.1"
                  value={inflationVolatility}
                  onChange={(e) =>
                    setInflationVolatility(Number(e.target.value))
                  }
                  className="w-full p-2 border border-gray-300 rounded-md"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Typical: 1.0% to 2.5%
                </p>
              </div>
              <div className="col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Iterations
                </label>
                <input
                  type="number"
                  step="500"
                  min={100}
                  max={20000}
                  value={monteCarloIterations}
                  onChange={(e) =>
                    setMonteCarloIterations(Number(e.target.value))
                  }
                  className="w-full p-2 border border-gray-300 rounded-md"
                />
                <p className="text-xs text-gray-500 mt-1">
                  More iterations → smoother bands, slower recompute (100 to
                  20,000)
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Results Section */}
        <div className="space-y-6">
          {/* Summary Cards */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white p-4 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <PiggyBank size={20} />
                <span className="text-sm opacity-90">
                  Corpus at Retirement
                </span>
              </div>
              <div className="text-2xl font-bold">
                {formatCurrency(calculations.corpusAtRetirement)}
              </div>
              <div className="text-xs opacity-80 mt-1">
                in {calculations.yearsToRetirement} years (deterministic)
              </div>
              {calculations.earmarkedAtRetirement > 0 && (
                <div className="text-xs opacity-90 mt-2 pt-2 border-t border-white/20">
                  <div>
                    Earmarked for goals:{" "}
                    {formatCurrency(calculations.earmarkedAtRetirement)}
                  </div>
                  <div>
                    Available for retirement:{" "}
                    {formatCurrency(calculations.mainCorpusAtRetirement)}
                  </div>
                </div>
              )}
            </div>
            <div className="bg-gradient-to-r from-green-500 to-green-600 text-white p-4 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <TrendingUp size={20} />
                <span className="text-sm opacity-90">Weighted Return</span>
              </div>
              <div className="text-2xl font-bold">
                {calculations.weightedReturn.toFixed(1)}%
              </div>
              <div className="text-xs opacity-80 mt-1">
                Real: {calculations.realReturn.toFixed(1)}%
              </div>
            </div>
          </div>

          {/* Key Metrics */}
          <div className="bg-yellow-50 p-6 rounded-lg">
            <h2 className="text-xl font-semibold mb-4 text-yellow-800">
              Key Metrics (Deterministic)
            </h2>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-700">Annual Expenses (today):</span>
                <span className="font-semibold">
                  {formatCurrency(calculations.annualExpenses)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">
                  Annual Expenses at Retirement:
                </span>
                <span className="font-semibold">
                  {formatCurrency(calculations.annualExpensesAtRetirement)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">
                  Real Return (after inflation):
                </span>
                <span
                  className={`font-semibold ${
                    calculations.realReturn >= 0
                      ? "text-green-600"
                      : "text-red-600"
                  }`}
                >
                  {calculations.realReturn.toFixed(1)}%
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">
                  Corpus Lasts Post-Retirement:
                </span>
                <span className="font-semibold text-blue-600">
                  {calculations.corpusLastsBeyondHorizon
                    ? `Beyond age ${targetAge}+`
                    : `${calculations.yearsAfterRetirement.toFixed(1)} years`}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-700">Money lasts until age:</span>
                <span className="font-semibold text-purple-600">
                  {calculations.corpusLastsBeyondHorizon
                    ? `${targetAge}+`
                    : Math.round(calculations.survivalAge)}
                </span>
              </div>
            </div>
          </div>

          {/* Monte Carlo Results */}
          <div className="bg-pink-50 p-6 rounded-lg">
            <h2 className="text-xl font-semibold mb-4 text-pink-800 flex items-center gap-2">
              <Sparkles size={20} />
              Monte Carlo Simulation
            </h2>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="bg-white p-3 rounded">
                <div className="text-xs text-gray-500 uppercase">
                  Success Rate
                </div>
                <div
                  className={`text-2xl font-bold ${
                    monteCarlo.successRate >= 0.85
                      ? "text-green-600"
                      : monteCarlo.successRate >= 0.6
                        ? "text-yellow-600"
                        : "text-red-600"
                  }`}
                >
                  {(monteCarlo.successRate * 100).toFixed(1)}%
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Paths solvent at age {targetAge} ({monteCarlo.iterations}{" "}
                  runs)
                </div>
              </div>
              <div className="bg-white p-3 rounded">
                <div className="text-xs text-gray-500 uppercase">
                  Median Survival Age
                </div>
                <div className="text-2xl font-bold text-blue-600">
                  {monteCarlo.medianDepletionAge >= targetAge
                    ? `${targetAge}+`
                    : Math.round(monteCarlo.medianDepletionAge)}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  When 50% of paths run out
                </div>
              </div>
              <div className="bg-white p-3 rounded">
                <div className="text-xs text-gray-500 uppercase">
                  P10 Final Corpus
                </div>
                <div className="text-lg font-semibold text-red-600">
                  {formatCurrency(monteCarlo.p10FinalCorpus)}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Pessimistic (10th percentile)
                </div>
              </div>
              <div className="bg-white p-3 rounded">
                <div className="text-xs text-gray-500 uppercase">
                  P90 Final Corpus
                </div>
                <div className="text-lg font-semibold text-green-600">
                  {formatCurrency(monteCarlo.p90FinalCorpus)}
                </div>
                <div className="text-xs text-gray-500 mt-1">
                  Optimistic (90th percentile)
                </div>
              </div>
            </div>

            <PercentileBandChart
              percentiles={monteCarlo.percentiles}
              retirementAge={retirementAge}
            />
          </div>

          {/* Future One-Time Expenses with funding status */}
          {calculations.expenseFundings.length > 0 && (
            <div className="bg-red-50 p-6 rounded-lg">
              <h2 className="text-xl font-semibold mb-4 text-red-800">
                Future One-Time Expenses
              </h2>
              <div className="space-y-3 max-h-72 overflow-y-auto">
                {calculations.expenseFundings.map((f, index) => {
                  const fullyLinked =
                    f.drainedFromLinked > 0 && f.drainedFromMain === 0 && f.shortfall === 0;
                  const partial =
                    f.drainedFromLinked > 0 && (f.drainedFromMain > 0 || f.shortfall > 0);
                  const unlinked = f.drainedFromLinked === 0;
                  const status = f.shortfall > 0
                    ? "shortfall"
                    : fullyLinked
                      ? "fully-linked"
                      : partial
                        ? "partial"
                        : "unlinked";
                  const statusColor =
                    status === "shortfall"
                      ? "border-red-400 bg-red-100"
                      : status === "fully-linked"
                        ? "border-green-300 bg-green-50"
                        : status === "partial"
                          ? "border-amber-300 bg-amber-50"
                          : "border-gray-200 bg-white";
                  return (
                    <div
                      key={index}
                      className={`p-3 rounded border ${statusColor}`}
                    >
                      <div className="flex justify-between items-baseline">
                        <span className="font-medium text-gray-800">
                          {f.expenseName}{" "}
                          <span className="text-xs text-gray-500">
                            (Age {f.ageWhenDue})
                          </span>
                        </span>
                        <span className="font-semibold text-red-600">
                          {formatCurrency(f.futureValue)}
                        </span>
                      </div>
                      <div className="text-xs text-gray-600 mt-1 space-y-0.5">
                        {f.drainedFromLinked > 0 && (
                          <div>
                            From SIP / earmarked pool:{" "}
                            <span className="font-medium text-green-700">
                              {formatCurrency(f.drainedFromLinked)}
                            </span>
                            {f.linkedBalanceBefore !== undefined && (
                              <span className="text-gray-500">
                                {" "}
                                (pool had{" "}
                                {formatCurrency(f.linkedBalanceBefore)})
                              </span>
                            )}
                          </div>
                        )}
                        {f.drainedFromMain > 0 && (
                          <div>
                            From main corpus (pro-rata):{" "}
                            <span
                              className={`font-medium ${
                                unlinked ? "text-gray-700" : "text-amber-700"
                              }`}
                            >
                              {formatCurrency(f.drainedFromMain)}
                            </span>
                          </div>
                        )}
                        {f.shortfall > 0 && (
                          <div>
                            <span className="font-medium text-red-700">
                              Shortfall: {formatCurrency(f.shortfall)}
                            </span>{" "}
                            <span className="text-gray-500">
                              — your savings could not cover this goal in
                              full.
                            </span>
                          </div>
                        )}
                        {f.surplusRolledOver !== undefined &&
                          f.surplusRolledOver > 0 && (
                            <div className="text-emerald-700 font-medium">
                              Surplus {formatCurrency(f.surplusRolledOver)}{" "}
                              rolls into your retirement corpus.
                            </div>
                          )}
                        {fullyLinked && f.surplusRolledOver === undefined && (
                          <div className="text-green-700 text-xs italic">
                            Fully funded by the linked SIP.
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Warnings */}
          {calculations.realReturn < 0 && (
            <div className="bg-red-50 border border-red-200 p-4 rounded-lg">
              <div className="flex items-center gap-2 text-red-700 mb-2">
                <AlertCircle size={20} />
                <span className="font-semibold">
                  Warning: Negative Real Return
                </span>
              </div>
              <p className="text-red-600 text-sm">
                Your weighted return ({calculations.weightedReturn.toFixed(1)}%)
                is lower than inflation ({inflation}%). Consider increasing
                allocation to higher-return investments.
              </p>
            </div>
          )}

          {monteCarlo.successRate < 0.7 && (
            <div className="bg-orange-50 border border-orange-200 p-4 rounded-lg">
              <div className="flex items-center gap-2 text-orange-700 mb-2">
                <AlertCircle size={20} />
                <span className="font-semibold">Low Success Probability</span>
              </div>
              <p className="text-orange-600 text-sm">
                Only {(monteCarlo.successRate * 100).toFixed(0)}% of simulated
                paths fund expenses through age {targetAge}. Consider
                increasing savings, retiring later, or reducing expenses.
              </p>
            </div>
          )}

          {/* Portfolio Allocation */}
          <div className="bg-purple-50 p-6 rounded-lg">
            <h2 className="text-xl font-semibold mb-4 text-purple-800">
              Portfolio Allocation (today)
            </h2>
            <div className="space-y-2">
              {(() => {
                const total = investmentBuckets.reduce(
                  (s, b) => s + b.amount,
                  0,
                );
                return investmentBuckets.map((bucket, index) => {
                  const pct = total > 0 ? (bucket.amount / total) * 100 : 0;
                  return (
                    <div
                      key={index}
                      className="flex justify-between items-center"
                    >
                      <span className="text-sm text-gray-700">
                        {bucket.name}:
                      </span>
                      <span className="text-sm font-medium">
                        {pct.toFixed(1)}% ({formatCurrency(bucket.amount)})
                      </span>
                    </div>
                  );
                });
              })()}
            </div>
          </div>

          {/* Year-by-year projection */}
          <div className="bg-gray-50 p-6 rounded-lg">
            <h2 className="text-xl font-semibold mb-4 text-gray-800">
              Year-by-Year Projection
            </h2>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {calculations.yearlyData.map(
                (data: YearlyProjection, index: number) => (
                  <div key={index} className="text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600">
                        Age {data.age}{" "}
                        <span
                          className={`text-xs ml-1 ${
                            data.isRetired
                              ? "text-purple-600"
                              : "text-blue-600"
                          }`}
                        >
                          ({data.isRetired ? "retired" : "working"})
                        </span>
                        :
                      </span>
                      <span className="font-medium">
                        {formatCurrency(data.corpus)}
                      </span>
                    </div>
                    <div className="text-xs text-gray-500 ml-4">
                      {data.isRetired ? (
                        <>Regular: {formatCurrency(data.regularExpenses)}</>
                      ) : (
                        <>
                          Contributions:{" "}
                          {formatCurrency(data.contributions)}
                        </>
                      )}
                      {data.oneTimeExpenses > 0 && (
                        <span className="text-red-600 ml-2">
                          One-time: {formatCurrency(data.oneTimeExpenses)}
                          {data.oneTimeItems.length > 0 && (
                            <span className="ml-1">
                              (
                              {data.oneTimeItems
                                .map((item: FutureOneTimeExpense) => item.name)
                                .join(", ")}
                              )
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

interface PercentileBandChartProps {
  percentiles: MonteCarloResult["percentiles"];
  retirementAge: number;
}

const PercentileBandChart = ({
  percentiles,
  retirementAge,
}: PercentileBandChartProps) => {
  if (percentiles.length === 0) return null;

  const width = 480;
  const height = 200;
  const padding = { top: 10, right: 12, bottom: 24, left: 48 };
  const innerW = width - padding.left - padding.right;
  const innerH = height - padding.top - padding.bottom;

  const minAge = percentiles[0].age;
  const maxAge = percentiles[percentiles.length - 1].age;
  const ageRange = Math.max(1, maxAge - minAge);

  const maxValue = Math.max(
    1,
    ...percentiles.map((p) => p.p90),
  );

  const xFor = (age: number) =>
    padding.left + ((age - minAge) / ageRange) * innerW;
  const yFor = (v: number) =>
    padding.top + innerH - (Math.max(0, v) / maxValue) * innerH;

  const buildArea = (
    upper: (p: MonteCarloResult["percentiles"][number]) => number,
    lower: (p: MonteCarloResult["percentiles"][number]) => number,
  ) => {
    const top = percentiles
      .map((p) => `${xFor(p.age)},${yFor(upper(p))}`)
      .join(" ");
    const bottom = percentiles
      .slice()
      .reverse()
      .map((p) => `${xFor(p.age)},${yFor(lower(p))}`)
      .join(" ");
    return `M ${top} L ${bottom} Z`;
  };

  const linePath = (key: keyof MonteCarloResult["percentiles"][number]) =>
    percentiles
      .map(
        (p, i) =>
          `${i === 0 ? "M" : "L"} ${xFor(p.age)} ${yFor(p[key] as number)}`,
      )
      .join(" ");

  const formatTick = (v: number) => {
    if (v >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`;
    if (v >= 1e5) return `${(v / 1e5).toFixed(0)}L`;
    if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
    return `${v.toFixed(0)}`;
  };

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxValue);

  return (
    <div className="bg-white rounded p-2 border border-pink-200">
      <div className="text-xs text-gray-600 mb-1 font-medium">
        Corpus distribution by age
      </div>
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* y-axis ticks */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={yFor(t)}
              y2={yFor(t)}
              stroke="#f1f5f9"
            />
            <text
              x={padding.left - 4}
              y={yFor(t) + 3}
              fontSize="9"
              textAnchor="end"
              fill="#64748b"
            >
              {formatTick(t)}
            </text>
          </g>
        ))}

        {/* P10–P90 band */}
        <path
          d={buildArea(
            (p) => p.p90,
            (p) => p.p10,
          )}
          fill="#fbcfe8"
          opacity="0.6"
        />
        {/* P25–P75 band */}
        <path
          d={buildArea(
            (p) => p.p75,
            (p) => p.p25,
          )}
          fill="#f9a8d4"
          opacity="0.7"
        />
        {/* Median line */}
        <path
          d={linePath("p50")}
          fill="none"
          stroke="#be185d"
          strokeWidth="1.5"
        />

        {/* Retirement age vertical marker */}
        {retirementAge >= minAge && retirementAge <= maxAge && (
          <g>
            <line
              x1={xFor(retirementAge)}
              x2={xFor(retirementAge)}
              y1={padding.top}
              y2={height - padding.bottom}
              stroke="#7c3aed"
              strokeDasharray="3,3"
            />
            <text
              x={xFor(retirementAge) + 3}
              y={padding.top + 9}
              fontSize="9"
              fill="#7c3aed"
            >
              retire @ {retirementAge}
            </text>
          </g>
        )}

        {/* x-axis labels */}
        {[minAge, Math.round((minAge + maxAge) / 2), maxAge].map((age) => (
          <text
            key={age}
            x={xFor(age)}
            y={height - 8}
            fontSize="9"
            textAnchor="middle"
            fill="#64748b"
          >
            age {age}
          </text>
        ))}
      </svg>
      <div className="flex gap-3 text-xs text-gray-600 mt-1 ml-12 flex-wrap">
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 inline-block bg-pink-200 rounded-sm" />
          P10–P90
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-3 inline-block bg-pink-300 rounded-sm" />
          P25–P75
        </span>
        <span className="flex items-center gap-1">
          <span className="w-3 h-0.5 inline-block bg-pink-700" /> Median
        </span>
      </div>
    </div>
  );
};

export default RetirementCalculator;
