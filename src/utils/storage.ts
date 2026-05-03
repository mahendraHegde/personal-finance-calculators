export type RetirementCalculatorConfig = {
  currentAge: number;
  retirementAge: number;
  inflation: number;
  monthlyExpenses: number;
  expenseType: "monthly" | "yearly";
  investmentBuckets: {
    id: number;
    name: string;
    amount: number;
    return: number;
  }[];
  monthlySavingsBuckets: {
    id: number;
    name: string;
    amount: number;
    return: number;
    targetRate?: number;
    glideYears?: number;
  }[];
  oneTimeExpenses: {
    id: number;
    name: string;
    yearsFromNow: number;
    currentCost: number;
    inflationRate: number;
    linkedSavingsBucketId?: number;
  }[];
  postRetirementBuckets: {
    id: number;
    name: string;
    allocationPct: number;
    return: number;
  }[];
  nextBucketId: number;
  nextSavingsBucketId: number;
  nextExpenseId: number;
  nextPostRetirementBucketId: number;
  targetAge: number;
  portfolioVolatility: number;
  inflationVolatility: number;
  monteCarloIterations: number;
};

const STORAGE_KEY = "retirement_calculator_config";

const defaultConfig: RetirementCalculatorConfig = {
  currentAge: 30,
  retirementAge: 60,
  inflation: 6,
  monthlyExpenses: 50000,
  expenseType: "monthly",
  investmentBuckets: [
    { id: 1, name: "Short Term (FD, Savings)", amount: 1000000, return: 7 },
    { id: 2, name: "Medium Term (Debt Funds)", amount: 2000000, return: 10 },
    { id: 3, name: "Long Term (Equity)", amount: 3000000, return: 12 },
  ],
  monthlySavingsBuckets: [],
  oneTimeExpenses: [
    {
      id: 1,
      name: "Car Purchase",
      yearsFromNow: 5,
      currentCost: 1000000,
      inflationRate: 5,
    },
    {
      id: 2,
      name: "Child Education",
      yearsFromNow: 15,
      currentCost: 2000000,
      inflationRate: 8,
    },
  ],
  postRetirementBuckets: [
    { id: 1, name: "Cash / Liquid", allocationPct: 10, return: 6 },
    { id: 2, name: "Debt", allocationPct: 30, return: 8 },
    { id: 3, name: "Equity", allocationPct: 60, return: 11 },
  ],
  nextBucketId: 4,
  nextSavingsBucketId: 1,
  nextExpenseId: 3,
  nextPostRetirementBucketId: 4,
  targetAge: 90,
  portfolioVolatility: 12,
  inflationVolatility: 1.5,
  monteCarloIterations: 2000,
};

/**
 * Get initial config for the retirement calculator.
 * Tries to load from localStorage, falls back to default.
 */
export function getInitialRetirementConfig(): RetirementCalculatorConfig {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (
          typeof parsed.currentAge === "number" &&
          typeof parsed.inflation === "number" &&
          typeof parsed.monthlyExpenses === "number" &&
          (parsed.expenseType === "monthly" ||
            parsed.expenseType === "yearly") &&
          Array.isArray(parsed.investmentBuckets) &&
          Array.isArray(parsed.oneTimeExpenses) &&
          typeof parsed.nextBucketId === "number" &&
          typeof parsed.nextExpenseId === "number"
        ) {
          // Forward-fill any missing fields with defaults so older saved
          // configs keep working after schema additions.
          return { ...defaultConfig, ...parsed };
        }
      }
    } catch (e) {
      console.error("Failed to load retirement config from localStorage:", e);
    }
  }
  return defaultConfig;
}

/**
 * Save the current config to localStorage.
 */
export function saveRetirementConfig(config: RetirementCalculatorConfig) {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      console.error("Failed to save retirement config:", e);
    }
  }
}
