// Where a satellite's passes come from; shaped like sampleSource. No inline fallback
// for a dead worker: 40 s of prediction on the main thread is worse than an empty table.

import type { SwathExtents } from "../../config/satelliteMetadata";
import type { GpRecord } from "./gp";
import { OrbitCache, runPassCommand, type PassCommand, type PassRequest, type PassResponse, type PassStation, type WorkerPass } from "./passWorker";

export type { PassStation, WorkerPass };

export interface PassQuery {
  mode: string;
  stations: PassStation[];
  startEpochMs: number;
  endEpochMs: number;
  swath: SwathExtents;
}

export interface PassPredictorSource {
  passes(query: PassQuery): Promise<WorkerPass[] | undefined>;
}

export interface PassSource {
  predictorFor(satnum: string, record: GpRecord): PassPredictorSource;
}

/** Eight commands is about 64 ms a reply, so a station's table fills in progressively. */
const MAX_COMMANDS_PER_MESSAGE = 8;

/** Predicts on the calling thread, for tests. */
export class InlinePassSource implements PassSource {
  readonly #cache = new OrbitCache();

  predictorFor(satnum: string, record: GpRecord): PassPredictorSource {
    return {
      passes: (query) => {
        const reply = runPassCommand(this.#cache, { kind: "passes", satnum, record, ...query });
        if (reply.kind !== "passes") {
          return Promise.resolve(undefined);
        }
        return Promise.resolve(reply.passes);
      },
    };
  }
}

interface Pending {
  resolve: (passes: WorkerPass[] | undefined) => void;
  satnum: string;
  query: PassQuery;
  record: GpRecord;
  sendRecord: boolean;
}

export class WorkerPassSource implements PassSource {
  #worker: Worker | undefined;

  #broken = false;

  #nextBatchId = 1;

  #queued: Pending[] = [];

  #flushScheduled = false;

  #inFlight = new Map<number, Pending[]>();

  #recordSent = new Set<string>();

  constructor() {
    if (typeof Worker !== "function") {
      this.#giveUp("this environment has no Worker");
      return;
    }
    try {
      this.#worker = new Worker(new URL("./passWorker.ts", import.meta.url), { type: "module" });
      this.#worker.addEventListener("message", (event: MessageEvent<PassResponse>) => this.#accept(event.data));
      this.#worker.addEventListener("error", (event) => this.#giveUp(event.message || "worker error"));
    } catch (error) {
      this.#giveUp(error instanceof Error ? error.message : String(error));
    }
  }

  predictorFor(satnum: string, record: GpRecord): PassPredictorSource {
    return {
      passes: (query) => {
        if (this.#broken) {
          return Promise.resolve(undefined);
        }
        const sendRecord = !this.#recordSent.has(satnum);
        this.#recordSent.add(satnum);
        return new Promise<WorkerPass[] | undefined>((resolve) => {
          this.#queued.push({ resolve, satnum, query, record, sendRecord });
          this.#schedule();
        });
      },
    };
  }

  /**
   * No deadline timer, unlike sampleSource: a batch can take a second, and nothing beats waiting.
   */
  #schedule(): void {
    if (this.#flushScheduled) {
      return;
    }
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      this.#flush();
    });
  }

  #flush(): void {
    const queued = this.#queued;
    this.#queued = [];
    if (queued.length === 0 || !this.#worker) {
      return;
    }
    for (let offset = 0; offset < queued.length; offset += MAX_COMMANDS_PER_MESSAGE) {
      const pending = queued.slice(offset, offset + MAX_COMMANDS_PER_MESSAGE);
      const batchId = this.#nextBatchId++;
      const commands: PassCommand[] = pending.map((item) =>
        item.sendRecord ? { kind: "passes", satnum: item.satnum, record: item.record, ...item.query } : { kind: "passes", satnum: item.satnum, ...item.query },
      );
      this.#inFlight.set(batchId, pending);
      // A transfer list, not a target origin — see sampleSource.
      // eslint-disable-next-line unicorn/require-post-message-target-origin
      this.#worker.postMessage({ batchId, commands } satisfies PassRequest);
    }
  }

  #accept(response: PassResponse): void {
    const pending = this.#inFlight.get(response.batchId);
    if (!pending) {
      return;
    }
    this.#inFlight.delete(response.batchId);
    response.replies.forEach((reply, index) => {
      const item = pending[index];
      if (!item) {
        return;
      }
      if (reply.kind === "passes") {
        item.resolve(reply.passes);
        return;
      }
      if (reply.kind === "unknown") {
        // Evicted, or this batch raced ahead of the one carrying the record.
        this.#recordSent.delete(reply.satnum);
        this.#queued.push({ ...item, sendRecord: true });
        this.#schedule();
        return;
      }
      item.resolve(undefined);
    });
  }

  /** Loud, and once: a dead worker otherwise looks like a station with nothing overhead. */
  #giveUp(reason: string): void {
    if (this.#broken) {
      return;
    }
    this.#broken = true;
    console.error(`Pass prediction worker unavailable (${reason}); pass tables will stay empty`);
    this.#worker?.terminate();
    this.#worker = undefined;
    for (const pending of this.#inFlight.values()) {
      for (const item of pending) {
        item.resolve(undefined);
      }
    }
    this.#inFlight.clear();
    const queued = this.#queued;
    this.#queued = [];
    for (const item of queued) {
      item.resolve(undefined);
    }
  }
}
