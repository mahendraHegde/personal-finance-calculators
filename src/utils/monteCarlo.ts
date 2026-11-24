import type {
  MonteCarloParams,
  MonteCarloPercentilePoint,
  MonteCarloResult,
} from "../types/retirement";
import { finiteOr, sanitizeAges, simulateRetirementPath } from "./retirement";

// Mulberry32: small, fast deterministic PRNG.  Same seed → same sequence,
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

// 32-bit integer hash (murmur3 finaliser), to derive well-separated
// per-path seeds from (seed, path index).
const mix32 = (a: number): number => {
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b);
  a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35);
  return (a ^ (a >>> 16)) >>> 0;
};

const percentile = (sortedAsc: number[], p: number): number => {
  if (sortedAsc.length === 0) return 0;
  const idx = (sortedAsc.length - 1) * Math.max(0, Math.min(1, p));
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
};

const bands = (
  byYear: number[][],
  currentAge: number,
): MonteCarloPercentilePoint[] =>
  byYear.map((values, year) => {
    const slice = values.slice().sort((a, b) => a - b);
    const mean =
      slice.length > 0 ? slice.reduce((s, x) => s + x, 0) / slice.length : 0;
    return {
      year,
      age: currentAge + year,
      p10: percentile(slice, 0.1),
      p25: percentile(slice, 0.25),
      p50: percentile(slice, 0.5),
      p75: percentile(slice, 0.75),
      p90: percentile(slice, 0.9),
      mean,
    };
  });

export function runMonteCarloSimulation(
  params: MonteCarloParams,
): MonteCarloResult {
  const iterations = Math.max(1, Math.floor(finiteOr(params.iterations, 1000)));
  const portfolioVolatility = Math.max(0, finiteOr(params.portfolioVolatility, 0));
  const inflationVolatility = Math.max(0, finiteOr(params.inflationVolatility, 0));
  const inflationPersistence = finiteOr(params.inflationPersistence, 0);
  const fatTails = Boolean(params.fatTails);
  // Same age rounding/clamping as the simulator, so year indices line up.
  const { currentAge, targetAge } = sanitizeAges(params);

  const seed =
    params.seed !== undefined && Number.isFinite(params.seed)
      ? params.seed | 0
      : Math.floor(Math.random() * 2 ** 31) | 0;

  // byYear[year][iter]: year 0 is today, the last index is targetAge.
  // Initialised to 0 so paths that ran out keep zeros for unwritten years.
  const totalYearsToTarget = targetAge - currentAge;
  const makeGrid = () =>
    Array.from(
      { length: totalYearsToTarget + 1 },
      () => new Array<number>(iterations).fill(0),
    );
  const nominalByYear = makeGrid();
  const realByYear = makeGrid();
  const depletionAges = new Array<number>(iterations);
  let successCount = 0;

  for (let iter = 0; iter < iterations; iter++) {
    // Each path gets its own stream.  With one shared stream, a path that
    // ran out early (and so drew fewer numbers) shifted the luck of every
    // later path, so nudging an input could reshuffle all of them: the
    // success rate jittered and could even rise with more spending.
    const rng = makeRng(mix32(seed ^ mix32(iter + 0x9e3779b9)));
    const sim = simulateRetirementPath(params, {
      rng,
      portfolioVolatility,
      inflationVolatility,
      inflationPersistence,
      fatTails,
    });
    nominalByYear[0][iter] = sim.startingCorpus;
    realByYear[0][iter] = sim.startingCorpus;
    for (const step of sim.steps) {
      if (step.year >= 1 && step.year <= totalYearsToTarget) {
        nominalByYear[step.year][iter] = step.corpus;
        realByYear[step.year][iter] = step.corpus / step.inflationIndex;
      }
    }
    // A path succeeds when living expenses stay funded until targetAge.
    const failed = sim.depleted && sim.survivalAge < targetAge;
    if (!failed) successCount++;
    depletionAges[iter] = sim.depleted
      ? Math.min(targetAge, sim.survivalAge)
      : targetAge;
  }

  const percentiles = bands(nominalByYear, currentAge);
  const realPercentiles = bands(realByYear, currentAge);
  const last = percentiles[percentiles.length - 1];
  const realLast = realPercentiles[realPercentiles.length - 1];
  const sortedDepletion = depletionAges.slice().sort((a, b) => a - b);

  return {
    iterations,
    successRate: successCount / iterations,
    percentiles,
    realPercentiles,
    depletionAges,
    medianDepletionAge: percentile(sortedDepletion, 0.5),
    p10DepletionAge: percentile(sortedDepletion, 0.1),
    medianFinalCorpus: last.p50,
    p10FinalCorpus: last.p10,
    p90FinalCorpus: last.p90,
    realMedianFinalCorpus: realLast.p50,
    realP10FinalCorpus: realLast.p10,
    realP90FinalCorpus: realLast.p90,
    targetAge,
  };
}
