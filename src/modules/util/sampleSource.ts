// Where a trajectory's samples come from: a worker pool for the app, or inline for
// tests and environments without workers. The pool coalesces a synchronous burst of
// requests per microtask, and pins each satnum to one worker (see `#laneFor`).

import type { GpRecord } from "./gp";
import { runCommand, SatrecCache, type Sgp4Chunk, type Sgp4Command, type Sgp4Request, type Sgp4Response } from "./sgp4Worker";

export type SampleChunk = Sgp4Chunk;

/** Bound to a satnum and element set, so `SampledTrajectory` never handles either. */
export interface TrajectorySampler {
  samples(fromEpochMs: number, toEpochMs: number): Promise<SampleChunk | undefined>;
}

export interface SampleSource {
  samplerFor(satnum: string, record: GpRecord): TrajectorySampler;
  readonly stats: SampleSourceStats;
}

export interface SampleSourceStats {
  requests: number;
  chunks: number;
  samples: number;
  refused: number;
  unopenable: number;
  /** Requests answered inline after the pool was given up on. */
  inlineFallbacks: number;
}

/**
 * How long a lane may go silent before it is presumed dead. Silence, not batch age:
 * the last batch of a large activation is legitimately unanswered for seconds, and
 * giving up is permanent and moves all propagation onto the main thread.
 */
const WORKER_SILENCE_MS = 4000;

/**
 * A cap, so the two threads pipeline. One message for a whole activation
 * structured-clones 5,000 element sets at once (a measured 133 ms frame), and the
 * worker cannot start until all of it is deserialised.
 */
const MAX_COMMANDS_PER_MESSAGE = 64;

const emptyStats = (): SampleSourceStats => ({ requests: 0, chunks: 0, samples: 0, refused: 0, unopenable: 0, inlineFallbacks: 0 });

/** Propagates on the calling thread: the tests' source, and the pool's fallback. */
export class InlineSampleSource implements SampleSource {
  readonly #cache = new SatrecCache();

  readonly stats = emptyStats();

  samplerFor(satnum: string, record: GpRecord): TrajectorySampler {
    return {
      samples: (fromEpochMs, toEpochMs) => {
        this.stats.requests += 1;
        const reply = runCommand(this.#cache, { kind: "sample", satnum, fromEpochMs, toEpochMs, record });
        if (reply.kind !== "chunk") {
          if (reply.kind === "unopenable") this.stats.unopenable += 1;
          return Promise.resolve(undefined);
        }
        this.stats.chunks += 1;
        this.stats.samples += reply.chunk.positionsFixed.length / 3;
        this.stats.refused += reply.chunk.refusedIndices.length;
        return Promise.resolve(reply.chunk);
      },
    };
  }
}

/** The record is kept even when not sent, so an `unknown` reply can be retried with it. */
interface Pending {
  resolve: (chunk: SampleChunk | undefined) => void;
  satnum: string;
  fromEpochMs: number;
  toEpochMs: number;
  record: GpRecord;
  sendRecord: boolean;
}

interface WorkerLane {
  worker: Worker;
  queued: Pending[];
  /** Keyed by batch id. */
  inFlight: Map<number, Pending[]>;
  /** Restarted by every reply from this worker. */
  silenceTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * The build drains at the speed of SGP4, which a pool splits. Bounded because the
 * main thread and the pass predictor's worker need cores too.
 *
 * `buildMs` medians against no pool: 27 → 19 at 100, 131 → 60 at 1,000, 562 → 321 at
 * 5,000, 1,508 → 993 at 10,000. Past about 5,000 the main thread's entity creation
 * dominates, so do not read this as a slope.
 *
 * Only worth it with the rotation in the worker (see sgp4Worker): with the rotation on
 * the main thread, a pool is worse than none at 10,000 (1,295 ms against 988). Four
 * beat two on every frame-time column at 5,000 and 10,000.
 */
const MAX_WORKERS = 4;

/**
 * Exported for its test. FNV-1a, not `Number(satnum) % laneCount`: a non-numeric
 * satnum parses to NaN, and all of them would land on one worker.
 */
export function laneIndexFor(satnum: string, laneCount: number): number {
  if (laneCount <= 1) {
    return 0;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < satnum.length; index += 1) {
    hash ^= satnum.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % laneCount;
}

function poolSize(): number {
  const cores = typeof navigator === "object" && navigator ? (navigator.hardwareConcurrency ?? 0) : 0;
  if (!Number.isFinite(cores) || cores <= 0) {
    // Unknown core count, which includes every environment without `navigator`.
    return 1;
  }
  return Math.max(1, Math.min(MAX_WORKERS, cores - 2));
}

export class WorkerSampleSource implements SampleSource {
  #lanes: WorkerLane[] = [];

  /** Set once the pool is given up on. */
  #inline: InlineSampleSource | undefined;

  /** Unique across lanes. */
  #nextBatchId = 1;

  #flushScheduled = false;

  /** Satnums whose record has been sent. See `record` in Sgp4SampleCommand. */
  #recordSent = new Set<string>();

  readonly stats = emptyStats();

  constructor() {
    if (typeof Worker !== "function") {
      this.#giveUp("this environment has no Worker");
      return;
    }
    try {
      for (let index = 0; index < poolSize(); index += 1) {
        const lane: WorkerLane = {
          worker: new Worker(new URL("./sgp4Worker.ts", import.meta.url), { type: "module" }),
          queued: [],
          inFlight: new Map(),
          silenceTimer: undefined,
        };
        lane.worker.addEventListener("message", (event: MessageEvent<Sgp4Response>) => this.#accept(lane, event.data));
        lane.worker.addEventListener("error", (event) => this.#giveUp(event.message || "worker error"));
        this.#lanes.push(lane);
      }
    } catch (error) {
      this.#giveUp(error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Must be a pure function of the satnum: the satrec cache and its eviction budget
   * are per worker, and the pool-wide `#recordSent` only says "this satellite's
   * worker holds it" while the mapping holds.
   */
  #laneFor(satnum: string): WorkerLane | undefined {
    return this.#lanes[laneIndexFor(satnum, this.#lanes.length)];
  }

  samplerFor(satnum: string, record: GpRecord): TrajectorySampler {
    return {
      samples: (fromEpochMs, toEpochMs) => {
        this.stats.requests += 1;
        if (this.#inline) {
          return this.#inlineSamples(satnum, record, fromEpochMs, toEpochMs);
        }
        const lane = this.#laneFor(satnum);
        if (!lane) {
          // Unreachable while the pool is up; without this the promise would never settle.
          this.#giveUp("no propagation worker");
          return this.#inlineSamples(satnum, record, fromEpochMs, toEpochMs);
        }
        const sendRecord = !this.#recordSent.has(satnum);
        this.#recordSent.add(satnum);
        return new Promise<SampleChunk | undefined>((resolve) => {
          lane.queued.push({ resolve, satnum, fromEpochMs, toEpochMs, record, sendRecord });
          this.#schedule();
        });
      },
    };
  }

  #inlineSamples(satnum: string, record: GpRecord, fromEpochMs: number, toEpochMs: number): Promise<SampleChunk | undefined> {
    const inline = this.#inline;
    if (!inline) {
      return Promise.resolve(undefined);
    }
    this.stats.inlineFallbacks += 1;
    return inline.samplerFor(satnum, record).samples(fromEpochMs, toEpochMs);
  }

  /** A microtask, not a frame: the build queue requests a whole chunk synchronously. */
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
    for (const lane of this.#lanes) {
      const queued = lane.queued;
      if (queued.length === 0) {
        continue;
      }
      lane.queued = [];
      for (let offset = 0; offset < queued.length; offset += MAX_COMMANDS_PER_MESSAGE) {
        const pending = queued.slice(offset, offset + MAX_COMMANDS_PER_MESSAGE);
        const batchId = this.#nextBatchId++;
        const commands: Sgp4Command[] = pending.map((item) =>
          item.sendRecord
            ? { kind: "sample", satnum: item.satnum, fromEpochMs: item.fromEpochMs, toEpochMs: item.toEpochMs, record: item.record }
            : { kind: "sample", satnum: item.satnum, fromEpochMs: item.fromEpochMs, toEpochMs: item.toEpochMs },
        );
        const request: Sgp4Request = { batchId, commands };
        lane.inFlight.set(batchId, pending);
        // A worker's second parameter is a transfer list, not a target origin: the
        // rule's fix, `postMessage(msg, self.location.origin)`, throws in Chrome.
        // eslint-disable-next-line unicorn/require-post-message-target-origin
        lane.worker.postMessage(request);
      }
      this.#armSilenceTimer(lane);
    }
  }

  /** Per lane, because an idle worker is legitimately silent. */
  #armSilenceTimer(lane: WorkerLane): void {
    if (lane.silenceTimer !== undefined) {
      clearTimeout(lane.silenceTimer);
      lane.silenceTimer = undefined;
    }
    if (lane.inFlight.size === 0 || this.#inline) {
      return;
    }
    lane.silenceTimer = setTimeout(() => this.#giveUp(`a worker said nothing for ${WORKER_SILENCE_MS} ms`), WORKER_SILENCE_MS);
  }

  #accept(lane: WorkerLane, response: Sgp4Response): void {
    const batch = lane.inFlight.get(response.batchId);
    if (!batch) {
      return;
    }
    lane.inFlight.delete(response.batchId);
    // Proof of life: the timer measures silence, not queue depth.
    this.#armSilenceTimer(lane);
    response.replies.forEach((reply, index) => {
      const pending = batch[index];
      if (!pending) {
        return;
      }
      if (reply.kind === "chunk") {
        this.stats.chunks += 1;
        this.stats.samples += reply.chunk.positionsFixed.length / 3;
        this.stats.refused += reply.chunk.refusedIndices.length;
        pending.resolve(reply.chunk);
        return;
      }
      if (reply.kind === "unknown") {
        // The satrec was evicted, or this batch overtook the one that creates it.
        // Retry with the record, on the same lane.
        this.#recordSent.delete(reply.satnum);
        lane.queued.push({ ...pending, sendRecord: true });
        this.#schedule();
        return;
      }
      this.stats.unopenable += 1;
      pending.resolve(undefined);
    });
  }

  /**
   * Loud, and once: otherwise a dead worker looks like a slow build. Every lane goes,
   * not only the failed one, so the catalog never propagates half off-thread.
   */
  #giveUp(reason: string): void {
    if (this.#inline) {
      return;
    }
    console.error(`SGP4 worker unavailable (${reason}); propagating on the main thread instead`);
    this.#inline = new InlineSampleSource();
    const lanes = this.#lanes;
    this.#lanes = [];
    for (const lane of lanes) {
      lane.worker.terminate();
      if (lane.silenceTimer !== undefined) {
        clearTimeout(lane.silenceTimer);
        lane.silenceTimer = undefined;
      }
      for (const pending of lane.inFlight.values()) {
        for (const item of pending) {
          this.#retryInline(item);
        }
      }
      lane.inFlight.clear();
      const queued = lane.queued;
      lane.queued = [];
      for (const item of queued) {
        this.#retryInline(item);
      }
    }
  }

  #retryInline(item: Pending): void {
    void this.#inlineSamples(item.satnum, item.record, item.fromEpochMs, item.toEpochMs).then(item.resolve);
  }
}
