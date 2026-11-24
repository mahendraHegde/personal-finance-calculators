// The heavy retirement computations, as serialisable jobs.  Run inside a Web
// Worker so the page never freezes, or inline when workers are unavailable.

import type { MonteCarloParams, MonteCarloResult } from "../types/retirement";
import { runMonteCarloSimulation } from "./monteCarlo";
import { solveGaps, summarizePlan, type GapSolution, type PlanSummary } from "./retirementSolver";

export type RetirementJob =
  | { kind: "mc"; params: MonteCarloParams }
  | { kind: "solve"; params: MonteCarloParams; target: number; iterations?: number }
  | { kind: "compare"; items: { key: string; params: MonteCarloParams }[]; iterations?: number };

export interface CompareRow {
  key: string;
  summary: PlanSummary;
}

export type JobResult<J extends RetirementJob> = J extends { kind: "mc" }
  ? MonteCarloResult
  : J extends { kind: "solve" }
    ? GapSolution
    : CompareRow[];

export function runRetirementJob<J extends RetirementJob>(job: J): JobResult<J> {
  switch (job.kind) {
    case "mc":
      return runMonteCarloSimulation(job.params) as JobResult<J>;
    case "solve":
      return solveGaps(job.params, job.target, job.iterations) as JobResult<J>;
    case "compare":
      return job.items.map((it) => ({
        key: it.key,
        summary: summarizePlan(it.params, job.iterations),
      })) as JobResult<J>;
  }
}

export interface WorkerRequest {
  id: number;
  job: RetirementJob;
}

export type WorkerResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };
