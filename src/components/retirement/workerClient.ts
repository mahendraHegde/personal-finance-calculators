// Client for the retirement Web Worker, with an inline fallback when workers
// can't start (old browsers, blocked scripts), plus React hooks.

import { useEffect, useState } from "react";
import type { MonteCarloParams, MonteCarloResult } from "../../types/retirement";
import {
  runRetirementJob,
  type JobResult,
  type RetirementJob,
  type WorkerResponse,
} from "../../utils/retirementJobs";

interface Pending {
  job: RetirementJob;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

const runInline = <J extends RetirementJob>(job: J): Promise<JobResult<J>> =>
  new Promise((resolve, reject) =>
    setTimeout(() => {
      try {
        resolve(runRetirementJob(job));
      } catch (e) {
        reject(e);
      }
    }, 0),
  );

export class RetirementWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();

  constructor() {
    try {
      this.worker = new Worker(
        new URL("../../workers/retirementWorker.ts", import.meta.url),
        { type: "module" },
      );
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const p = this.pending.get(e.data.id);
        if (!p) return;
        this.pending.delete(e.data.id);
        if (e.data.ok) p.resolve(e.data.result);
        else p.reject(new Error(e.data.error));
      };
      // The worker failed to load, crashed, or sent something that couldn't
      // be read back: finish everything inline from now on.
      const fallBack = () => {
        this.worker?.terminate();
        this.worker = null;
        const waiting = [...this.pending.values()];
        this.pending.clear();
        for (const p of waiting) runInline(p.job).then(p.resolve, p.reject);
      };
      this.worker.onerror = fallBack;
      this.worker.onmessageerror = fallBack;
    } catch {
      this.worker = null;
    }
  }

  run<J extends RetirementJob>(job: J): Promise<JobResult<J>> {
    if (!this.worker) return runInline(job);
    const id = ++this.seq;
    return new Promise<JobResult<J>>((resolve, reject) => {
      this.pending.set(id, {
        job,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.worker!.postMessage({ id, job });
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    for (const p of this.pending.values()) p.reject(new Error("disposed"));
    this.pending.clear();
  }
}

// One worker per hook user, created after mount and terminated on unmount.
export function useWorkerClient(): RetirementWorkerClient | null {
  const [client, setClient] = useState<RetirementWorkerClient | null>(null);
  useEffect(() => {
    const c = new RetirementWorkerClient();
    setClient(c);
    return () => c.dispose();
  }, []);
  return client;
}

// Live Monte Carlo for the current inputs, debounced so a burst of typing
// runs one simulation.  `pending` is true while the shown result is for
// older inputs.
export function useMonteCarlo(
  client: RetirementWorkerClient | null,
  params: MonteCarloParams,
): { result: MonteCarloResult | null; pending: boolean; error: string | null } {
  const [state, setState] = useState<{
    result: MonteCarloResult | null;
    forParams: MonteCarloParams | null;
    error: string | null;
  }>({ result: null, forParams: null, error: null });
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    const t = setTimeout(() => {
      client.run({ kind: "mc", params }).then(
        (result) => {
          if (!cancelled) setState({ result, forParams: params, error: null });
        },
        (e: unknown) => {
          if (!cancelled)
            setState((s) => ({ ...s, forParams: params, error: e instanceof Error ? e.message : String(e) }));
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [client, params]);
  return { result: state.result, pending: state.forParams !== params, error: state.error };
}
