// SGP4 propagation, off the main thread. Cesium-free: satellite.js, the GP record
// helpers and the TEME-to-pseudo-fixed rotation (see temeToFixed). Fixed to ICRF
// needs Cesium's asynchronously loaded IAU data, so it stays on the main thread.
//
// A request names an interval and the answer is a pure function of it, so requests
// are idempotent; the satrec cache is only a memo. Sample times sit on a grid
// anchored to the element set's epoch, `t_i = epoch + i·step`, so consecutive
// requests interleave evenly and their bounds may be approximate.

import * as satellitejs from "satellite.js";

import { createSatrec, type GpRecord } from "./gp";
import { fixedRotationAt, type FixedRotation } from "./temeToFixed";
import { SAMPLES_PER_ORBIT } from "./trajectoryWindow";

/** Julian date of the Unix epoch. */
const JD_UNIX_EPOCH = 2440587.5;

const MS_PER_DAY = 86_400_000;

/**
 * Every grid sample inside `[fromEpochMs, toEpochMs]`. `record` is needed only when
 * the worker holds no satrec for `satnum`; sending it every time would structured-clone
 * thousands of OMM objects a second at ×1000 and 5,000 satellites.
 */
export interface Sgp4SampleCommand {
  kind: "sample";
  satnum: string;
  fromEpochMs: number;
  toEpochMs: number;
  record?: GpRecord;
}

export type Sgp4Command = Sgp4SampleCommand;

export interface Sgp4Request {
  batchId: number;
  commands: Sgp4Command[];
}

export interface Sgp4Chunk {
  satnum: string;
  /**
   * Sample i is at `anchorEpochMs + (firstIndex + i) · stepSeconds`. Never place
   * samples from a per-chunk start: `Date` rounds it to whole milliseconds, and two
   * chunks then disagree about one grid instant (measured: a zero-displacement pair).
   */
  anchorEpochMs: number;
  firstIndex: number;
  /** Epoch milliseconds of the first sample. Not used for placement. */
  startEpochMs: number;
  stepSeconds: number;
  /**
   * Metres, in Cesium's pseudo-fixed frame: `computeTemeToPseudoFixedMatrix`
   * reproduced exactly, not `eciToEcf`, which uses another GMST formulation.
   */
  positionsFixed: Float64Array;
  /**
   * Samples the propagator refused (decayed, diverging, far from epoch); their
   * triples are zero. Skip them: a retry fails identically.
   */
  refusedIndices: number[];
}

export type Sgp4Reply =
  | { kind: "chunk"; chunk: Sgp4Chunk }
  // No satrec held for this satellite. Retry with `record` attached.
  | { kind: "unknown"; satnum: string }
  // The element set cannot be propagated at all; no retry will help.
  | { kind: "unopenable"; satnum: string; reason: string };

export interface Sgp4Response {
  batchId: number;
  replies: Sgp4Reply[];
}

/** Where this element set's grid is anchored, in epoch milliseconds. */
export function gridAnchorEpochMs(satrec: satellitejs.SatRec): number {
  // Some satellite.js versions split the epoch across `jdsatepoch` and `jdsatepochF`.
  const fractional = (satrec as unknown as { jdsatepochF?: number }).jdsatepochF ?? 0;
  return (satrec.jdsatepoch + fractional - JD_UNIX_EPOCH) * MS_PER_DAY;
}

export function gridStepSeconds(satrec: satellitejs.SatRec): number {
  const meanMotionRad = satrec.no;
  if (!Number.isFinite(meanMotionRad) || meanMotionRad <= 0) {
    return 0;
  }
  const orbitalPeriodMinutes = (2 * Math.PI) / meanMotionRad;
  return (orbitalPeriodMinutes * 60) / SAMPLES_PER_ORBIT;
}

/**
 * Undefined when the element set yields no usable grid. Pure, so the inline source
 * and the tests run it without a worker.
 */
export function sampleInterval(satrec: satellitejs.SatRec, satnum: string, fromEpochMs: number, toEpochMs: number): Sgp4Chunk | undefined {
  const stepSeconds = gridStepSeconds(satrec);
  const anchor = gridAnchorEpochMs(satrec);
  if (stepSeconds <= 0 || !Number.isFinite(anchor)) {
    return undefined;
  }
  const stepMs = stepSeconds * 1000;
  const firstIndex = Math.ceil((fromEpochMs - anchor) / stepMs);
  const lastIndex = Math.floor((toEpochMs - anchor) / stepMs);
  const sampleCount = lastIndex - firstIndex + 1;
  const startEpochMs = anchor + firstIndex * stepMs;
  if (sampleCount <= 0) {
    // Narrower than one step: answered with no samples, never an off-grid one.
    return { satnum, anchorEpochMs: anchor, firstIndex, startEpochMs, stepSeconds, positionsFixed: new Float64Array(0), refusedIndices: [] };
  }

  // Rotate at `trunc(anchor)`: the consumer turns the anchor into a JulianDate through
  // `Date`, which drops sub-millisecond digits. The untruncated instant is up to 4.3 cm off.
  const rotationAnchorMs = Math.trunc(anchor);
  const rotation: FixedRotation = { cos: 1, sin: 0 };
  const positionsFixed = new Float64Array(sampleCount * 3);
  const refusedIndices: number[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const propagated = satellitejs.propagate(satrec, new Date(startEpochMs + index * stepMs));
    const position = propagated?.position;
    if (satrec.error || !position || typeof position === "boolean") {
      refusedIndices.push(index);
      continue;
    }
    const x = position.x * 1000;
    const y = position.y * 1000;
    fixedRotationAt(rotationAnchorMs + (firstIndex + index) * stepMs, rotation);
    positionsFixed[index * 3] = rotation.cos * x + rotation.sin * y;
    positionsFixed[index * 3 + 1] = rotation.cos * y - rotation.sin * x;
    positionsFixed[index * 3 + 2] = position.z * 1000;
  }
  return { satnum, anchorEpochMs: anchor, firstIndex, startEpochMs, stepSeconds, positionsFixed, refusedIndices };
}

/**
 * A miss costs one `sgp4init`, so nothing tells the worker when a satellite goes
 * away. Per worker, but a satellite stays on one worker (see `#laneFor` in
 * sampleSource), so the pool holds at most the catalog.
 */
const MAX_CACHED_SATRECS = 20_000;

/**
 * Keyed by satnum, not catalog key: entries that share a satnum have byte-identical
 * element sets on the live catalog, so they share a propagator.
 */
export class SatrecCache {
  #bySatnum = new Map<string, satellitejs.SatRec>();

  get(satnum: string): satellitejs.SatRec | undefined {
    return this.#bySatnum.get(satnum);
  }

  set(satnum: string, satrec: satellitejs.SatRec): void {
    if (this.#bySatnum.size >= MAX_CACHED_SATRECS) {
      // Drops the oldest insertion; a miss costs microseconds.
      const oldest = this.#bySatnum.keys().next().value;
      if (oldest !== undefined) {
        this.#bySatnum.delete(oldest);
      }
    }
    this.#bySatnum.set(satnum, satrec);
  }

  get size(): number {
    return this.#bySatnum.size;
  }
}

/** Shared by the worker and the inline source. */
export function runCommand(cache: SatrecCache, command: Sgp4Command): Sgp4Reply {
  let satrec = cache.get(command.satnum);
  if (!satrec) {
    if (!command.record) {
      return { kind: "unknown", satnum: command.satnum };
    }
    try {
      satrec = createSatrec(command.record);
    } catch (error) {
      return { kind: "unopenable", satnum: command.satnum, reason: error instanceof Error ? error.message : String(error) };
    }
    cache.set(command.satnum, satrec);
  }
  const chunk = sampleInterval(satrec, command.satnum, command.fromEpochMs, command.toEpochMs);
  return chunk ? { kind: "chunk", chunk } : { kind: "unopenable", satnum: command.satnum, reason: "no usable mean motion" };
}

/**
 * Checks for no `window`, not for `self`: on the main thread `self` is the window,
 * and the tests and the inline source import this module there.
 */
const inWorkerScope = typeof (globalThis as { window?: unknown }).window === "undefined" && typeof (globalThis as { postMessage?: unknown }).postMessage === "function";

if (inWorkerScope) {
  const cache = new SatrecCache();
  self.addEventListener("message", (event: MessageEvent<Sgp4Request>) => {
    const { batchId, commands } = event.data;
    const replies = commands.map((command) => runCommand(cache, command));
    const response: Sgp4Response = { batchId, replies };
    const buffers = replies.filter((reply): reply is { kind: "chunk"; chunk: Sgp4Chunk } => reply.kind === "chunk").map((reply) => reply.chunk.positionsFixed.buffer);
    (self as unknown as { postMessage(message: Sgp4Response, transfer: Transferable[]): void }).postMessage(response, buffers);
  });
}
