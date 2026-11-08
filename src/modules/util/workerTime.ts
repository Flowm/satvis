// CPU time the app's workers spent on their messages, which the main thread's frame callbacks
// do not see: propagation and pass prediction. Each worker times its own handling and returns
// it with its answer; browsers offer no process CPU time.

let totalMs = 0;

/** Adds a worker's count of one message's handling, in milliseconds. */
export function addWorkerTime(ms: number | undefined): void {
  if (ms !== undefined && Number.isFinite(ms) && ms > 0) {
    totalMs += ms;
  }
}

/** Since the page loaded, in milliseconds. */
export function workerTimeMs(): number {
  return totalMs;
}
