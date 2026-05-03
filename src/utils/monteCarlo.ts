import type {
  MonteCarloParams,
  MonteCarloPercentilePoint,
  MonteCarloResult,
} from "../types/retirement";
import { simulateRetirementPath } from "./retirement";

// Mulberry32 — small, fast deterministic PRNG.  Same seed → same sequence,
// which gives the user a stable result that doesn't jitter on every keystroke.
const makeRng = (seed: number): (() => number) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const percentile = (sortedAsc: number[], p: number): number => {
  if (sortedAsc.length === 0) return 0;
  const idx = (sortedAsc.length - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
};

const finiteOr = (v: number | undefined | null, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

export function runMonteCarloSimulation(
  params: MonteCarloParams,
): MonteCarloResult {
  // Sanitize MC-specific knobs
  const iterations = Math.max(
    1,
    Math.floor(finiteOr(params.iterations, 1000)),
  );
  const portfolioVolatility = Math.max(
    0,
    finiteOr(params.portfolioVolatility, 0),
  );
  const inflationVolatility = Math.max(
    0,
    finiteOr(params.inflationVolatility, 0),
  );
  const targetAge = Math.max(
    finiteOr(params.retirementAge, 0) + 1,
    finiteOr(params.targetAge, 90),
  );

  const seed =
    params.seed !== undefined && Number.isFinite(params.seed)
      ? params.seed | 0
      : Math.floor(Math.random() * 2 ** 31) | 0;
  const rng = makeRng(seed);

  // We simulate from currentAge to targetAge.  Length of the output array
  // must match the maximum step count produced by simulateRetirementPath
  // (which goes to targetAge+5).  We slice to targetAge for percentile
  // reporting so the user-facing window matches their "Plan Until Age".
  const currentAge = Math.max(0, finiteOr(params.currentAge, 0));
  const totalYearsToTarget = Math.max(1, targetAge - currentAge);

  // corpusByYear[year][iter] — year 0 is today, year totalYearsToTarget
  // is targetAge.  Initialised to 0 so depleted-and-broken-out paths
  // naturally keep zeros for unwritten years.
  const corpusByYear: number[][] = Array.from(
    { length: totalYearsToTarget + 1 },
    () => new Array<number>(iterations).fill(0),
  );
  const depletionAges = new Array<number>(iterations);

  const initialCorpus = params.investmentBuckets.reduce(
    (s, b) => s + Math.max(0, finiteOr(b.amount, 0)),
    0,
  );

  for (let iter = 0; iter < iterations; iter++) {
    corpusByYear[0][iter] = initialCorpus;

    const sim = simulateRetirementPath(
      { ...params, targetAge },
      { rng, portfolioVolatility, inflationVolatility },
    );

    // Copy the path into corpusByYear[1..totalYearsToTarget].  The simulator
    // produces steps with `year` running 1..(yearsToRetirement + ~horizon).
    // Steps beyond targetAge are ignored.  Years before depletion that are
    // missing from the steps array (early break) are left as 0.
    for (const step of sim.steps) {
      if (step.year >= 1 && step.year <= totalYearsToTarget) {
        corpusByYear[step.year][iter] = step.corpus;
      }
    }

    // Depletion age, capped at targetAge for the success-rate metric so a
    // path that survives the whole window contributes targetAge to the
    // distribution rather than an arbitrary horizon value.
    if (sim.depleted) {
      depletionAges[iter] = Math.min(targetAge, sim.survivalAge);
    } else {
      depletionAges[iter] = targetAge;
    }
  }

  // Build percentile bands per year
  const percentiles: MonteCarloPercentilePoint[] = [];
  for (let year = 0; year <= totalYearsToTarget; year++) {
    const slice = corpusByYear[year].slice().sort((a, b) => a - b);
    const meanVal =
      slice.length > 0 ? slice.reduce((s, x) => s + x, 0) / slice.length : 0;
    percentiles.push({
      year,
      age: currentAge + year,
      p10: percentile(slice, 0.1),
      p25: percentile(slice, 0.25),
      p50: percentile(slice, 0.5),
      p75: percentile(slice, 0.75),
      p90: percentile(slice, 0.9),
      mean: meanVal,
    });
  }

  // Success rate: % of paths whose corpus at targetAge is > 0.  We use a
  // tiny epsilon (₹1) rather than > 0 to absorb floating-point dust from
  // the depletion-fraction calculation.
  const finalCorpora = corpusByYear[totalYearsToTarget].slice().sort(
    (a, b) => a - b,
  );
  const successCount = finalCorpora.filter((c) => c > 1).length;
  const sortedDepletion = depletionAges.slice().sort((a, b) => a - b);

  return {
    iterations,
    successRate: iterations > 0 ? successCount / iterations : 0,
    percentiles,
    depletionAges,
    medianDepletionAge: percentile(sortedDepletion, 0.5),
    medianFinalCorpus: percentile(finalCorpora, 0.5),
    p10FinalCorpus: percentile(finalCorpora, 0.1),
    p90FinalCorpus: percentile(finalCorpora, 0.9),
    targetAge,
  };
}
