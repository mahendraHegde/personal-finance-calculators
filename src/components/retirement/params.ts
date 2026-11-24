// Turn the saved calculator config into engine inputs.

import type {
  MonteCarloParams,
  RetirementCalculationParams,
} from "../../types/retirement";
import type { RetirementCalculatorConfig } from "../../utils/storage";

export type SetConfig = (
  update: (c: RetirementCalculatorConfig) => RetirementCalculatorConfig,
) => void;

export const toParams = (c: RetirementCalculatorConfig): RetirementCalculationParams => ({
  currentAge: c.currentAge,
  retirementAge: c.retirementAge,
  inflation: c.inflation,
  monthlyExpenses: c.monthlyExpenses,
  expenseType: c.expenseType,
  investmentBuckets: c.investmentBuckets,
  monthlySavingsBuckets: c.monthlySavingsBuckets,
  oneTimeExpenses: c.oneTimeExpenses,
  postRetirementBuckets: c.postRetirementBuckets,
  incomeStreams: c.incomeStreams,
  spendingPhases: c.spendingPhases,
  healthcare: c.healthcare,
  tax: c.tax,
  withdrawalStrategy: c.withdrawalStrategy,
  cashBufferYears: c.cashBufferYears,
  // Blank bucket volatilities mean "the default" in both views.
  defaultVolatility: c.portfolioVolatility,
  targetAge: c.targetAge,
});

export const toMcParams = (c: RetirementCalculatorConfig): MonteCarloParams => ({
  ...toParams(c),
  targetAge: c.targetAge,
  portfolioVolatility: c.portfolioVolatility,
  inflationVolatility: c.inflationVolatility,
  inflationPersistence: c.inflationPersistence,
  fatTails: c.fatTails,
  iterations: Math.max(100, Math.min(20000, c.monteCarloIterations || 0)),
  seed: 42,
});
