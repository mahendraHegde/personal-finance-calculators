import type {
  HealthcareCosts,
  IncomeStream,
  PostRetirementBucket,
  RetirementCalculationParams,
  SpendingPhase,
  TaxSettings,
  WithdrawalStrategy,
} from "../types/retirement";
import {
  DEFAULT_CASH_BUFFER_YEARS,
  DEFAULT_TAX,
  DEFAULT_VOLATILITY,
} from "./retirement";

// Everything the calculator persists: the engine inputs (with the optional
// ones made required) plus id counters, Monte Carlo knobs and UI settings.
export type RetirementCalculatorConfig = Omit<
  RetirementCalculationParams,
  | "targetAge"
  | "postRetirementBuckets"
  | "incomeStreams"
  | "spendingPhases"
  | "healthcare"
  | "tax"
  | "withdrawalStrategy"
  | "cashBufferYears"
> & {
  targetAge: number;
  postRetirementBuckets: PostRetirementBucket[];
  incomeStreams: IncomeStream[];
  spendingPhases: SpendingPhase[];
  healthcare: HealthcareCosts;
  tax: TaxSettings;
  withdrawalStrategy: WithdrawalStrategy;
  cashBufferYears: number;
  nextBucketId: number;
  nextSavingsBucketId: number;
  nextExpenseId: number;
  nextPostRetirementBucketId: number;
  nextIncomeStreamId: number;
  nextSpendingPhaseId: number;
  portfolioVolatility: number;
  inflationVolatility: number;
  inflationPersistence: number;
  fatTails: boolean;
  monteCarloIterations: number;
  // Success rate the "what would it take" solver aims for (0..1).
  solverTargetSuccess: number;
};

export interface RetirementScenario {
  id: string;
  name: string;
  savedAt: string; // ISO timestamp
  config: RetirementCalculatorConfig;
}

const STORAGE_KEY = "retirement_calculator_config";
const SCENARIOS_KEY = "retirement_calculator_scenarios";

export const defaultConfig: RetirementCalculatorConfig = {
  currentAge: 30,
  retirementAge: 60,
  inflation: 6,
  monthlyExpenses: 50000,
  expenseType: "monthly",
  investmentBuckets: [
    { id: 1, name: "Short Term (FD, Savings)", amount: 1000000, return: 7, volatility: 1 },
    { id: 2, name: "Medium Term (Debt Funds)", amount: 2000000, return: 10, volatility: 4 },
    { id: 3, name: "Long Term (Equity)", amount: 3000000, return: 12, volatility: 16 },
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
  // Pre-tax returns with tax treatments, so tax is computed rather than
  // guessed.
  postRetirementBuckets: [
    { id: 1, name: "Cash / Liquid", allocationPct: 10, return: 6.5, volatility: 1, taxTreatment: "slabYearly" },
    { id: 2, name: "Debt", allocationPct: 30, return: 7.5, volatility: 4, taxTreatment: "slabOnSale" },
    { id: 3, name: "Equity", allocationPct: 60, return: 12, volatility: 16, taxTreatment: "equity" },
  ],
  incomeStreams: [],
  spendingPhases: [],
  healthcare: { monthlyCost: 0, inflation: 10 },
  tax: { ...DEFAULT_TAX },
  withdrawalStrategy: "proRata",
  cashBufferYears: DEFAULT_CASH_BUFFER_YEARS,
  nextBucketId: 4,
  nextSavingsBucketId: 1,
  nextExpenseId: 3,
  nextPostRetirementBucketId: 4,
  nextIncomeStreamId: 1,
  nextSpendingPhaseId: 1,
  targetAge: 90,
  portfolioVolatility: DEFAULT_VOLATILITY,
  inflationVolatility: 1.5,
  inflationPersistence: 0.6,
  fatTails: true,
  monteCarloIterations: 2000,
  solverTargetSuccess: 0.9,
};

// A stored object is usable when the fields every older version wrote are
// present; anything newer is forward-filled from the defaults.
const isConfigLike = (parsed: unknown): parsed is Partial<RetirementCalculatorConfig> => {
  const p = parsed as Record<string, unknown> | null;
  return (
    !!p &&
    typeof p.currentAge === "number" &&
    typeof p.inflation === "number" &&
    typeof p.monthlyExpenses === "number" &&
    (p.expenseType === "monthly" || p.expenseType === "yearly") &&
    Array.isArray(p.investmentBuckets) &&
    Array.isArray(p.oneTimeExpenses) &&
    typeof p.nextBucketId === "number" &&
    typeof p.nextExpenseId === "number"
  );
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Forward-fill missing fields so older saved configs keep working after
// schema additions, and replace any field of the wrong type (hand-edited or
// corrupted storage) with its default rather than crashing the page.
export const normalizeConfig = (
  parsed: Partial<RetirementCalculatorConfig>,
): RetirementCalculatorConfig => {
  const out: Record<string, unknown> = { ...defaultConfig };
  const defaults = defaultConfig as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(key in defaults)) continue;
    const d = defaults[key];
    const sameType =
      Array.isArray(d)
        ? Array.isArray(value) && value.every(isObject)
        : isObject(d)
          ? isObject(value)
          : typeof d === typeof value && (typeof value !== "number" || Number.isFinite(value));
    if (sameType) out[key] = value;
  }
  const merged = out as unknown as RetirementCalculatorConfig;
  return {
    ...merged,
    healthcare: { ...defaultConfig.healthcare, ...merged.healthcare },
    tax: { ...defaultConfig.tax, ...merged.tax },
  };
};

const storage = (): Storage | null => {
  try {
    return typeof window !== "undefined" && window.localStorage ? window.localStorage : null;
  } catch {
    return null;
  }
};

/**
 * Get initial config for the retirement calculator.
 * Tries to load from localStorage, falls back to default.
 */
export function getInitialRetirementConfig(): RetirementCalculatorConfig {
  const ls = storage();
  if (ls) {
    try {
      const raw = ls.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (isConfigLike(parsed)) return normalizeConfig(parsed);
      }
    } catch (e) {
      console.error("Failed to load retirement config from localStorage:", e);
    }
  }
  return defaultConfig;
}

/**
 * Save the current config to localStorage.  Returns false when it couldn't
 * be saved (private mode, storage full).
 */
export function saveRetirementConfig(config: RetirementCalculatorConfig): boolean {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(config));
    return true;
  } catch (e) {
    console.error("Failed to save retirement config:", e);
    return false;
  }
}

export function listScenarios(): RetirementScenario[] {
  const ls = storage();
  if (!ls) return [];
  try {
    const parsed = JSON.parse(ls.getItem(SCENARIOS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (s): s is RetirementScenario =>
          !!s && typeof s.id === "string" && typeof s.name === "string" && isConfigLike(s.config),
      )
      .map((s) => ({ ...s, config: normalizeConfig(s.config) }));
  } catch {
    return [];
  }
}

export function saveScenarios(scenarios: RetirementScenario[]): boolean {
  const ls = storage();
  if (!ls) return false;
  try {
    ls.setItem(SCENARIOS_KEY, JSON.stringify(scenarios));
    return true;
  } catch (e) {
    console.error("Failed to save scenarios:", e);
    return false;
  }
}

export const newScenarioId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
