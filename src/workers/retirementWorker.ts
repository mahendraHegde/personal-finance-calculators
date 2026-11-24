// Web Worker running retirement simulations off the main thread.

import { runRetirementJob, type WorkerRequest, type WorkerResponse } from "../utils/retirementJobs";

// Typed narrowly so this file doesn't need the WebWorker lib (it would clash
// with the DOM lib the rest of the app compiles against).
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (msg: WorkerResponse) => void;
};

ctx.onmessage = (e) => {
  const { id, job } = e.data;
  try {
    ctx.postMessage({ id, ok: true, result: runRetirementJob(job) });
  } catch (err) {
    ctx.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
