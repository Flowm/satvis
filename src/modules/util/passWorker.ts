// Pass prediction, off the main thread. Not shared with the sampling worker: a
// five-day window is ~8 ms of SGP4 per satellite per station, so 5,000 satellites
// are ~40 s that would queue in front of every sample request. Cesium-free.

import type { SwathExtents } from "../../config/satelliteMetadata";
import Orbit from "../Orbit";
import type { ElevationPass, GroundStationPosition, SwathPass } from "../Orbit";
import type { GpRecord } from "./gp";

/** `Pass` in PassPredictor is this plus Cesium's imports. */
export type WorkerPass = (ElevationPass | SwathPass) & { groundStationName?: string };

export interface PassStation {
  name: string;
  position: GroundStationPosition;
}

/**
 * One command per satellite, so a reply means "this satellite is done". `record` is
 * needed only when the worker holds no orbit for `satnum` (see Sgp4SampleCommand).
 */
export interface PassCommand {
  kind: "passes";
  satnum: string;
  record?: GpRecord;
  /** "elevation" (line-of-sight) or "swath" (sensor footprint). */
  mode: string;
  stations: PassStation[];
  startEpochMs: number;
  endEpochMs: number;
  /** Read per request, not cached: a record arriving later changes it. */
  swath: SwathExtents;
}

export type PassReply =
  | { kind: "passes"; satnum: string; passes: WorkerPass[] }
  // Retry with `record` attached.
  | { kind: "unknown"; satnum: string }
  // No retry will help.
  | { kind: "unopenable"; satnum: string; reason: string };

export interface PassRequest {
  batchId: number;
  commands: PassCommand[];
}

export interface PassResponse {
  batchId: number;
  replies: PassReply[];
}

/** A miss costs one `sgp4init`, so eviction is cheap and nothing tracks removed satellites. */
const MAX_CACHED_ORBITS = 20_000;

/**
 * Keyed on satnum alone, without the name: the main thread overwrites the name on
 * each pass, and catalog entries sharing a satnum share one propagator.
 */
export class OrbitCache {
  #bySatnum = new Map<string, Orbit>();

  get(satnum: string): Orbit | undefined {
    return this.#bySatnum.get(satnum);
  }

  set(satnum: string, orbit: Orbit): void {
    if (this.#bySatnum.size >= MAX_CACHED_ORBITS) {
      const oldest = this.#bySatnum.keys().next().value;
      if (oldest !== undefined) {
        this.#bySatnum.delete(oldest);
      }
    }
    this.#bySatnum.set(satnum, orbit);
  }

  get size(): number {
    return this.#bySatnum.size;
  }
}

/** Shared by the worker and the inline source. */
export function runPassCommand(cache: OrbitCache, command: PassCommand): PassReply {
  let orbit = cache.get(command.satnum);
  if (!orbit) {
    if (!command.record) {
      return { kind: "unknown", satnum: command.satnum };
    }
    try {
      // Empty name: see OrbitCache.
      orbit = new Orbit("", command.record);
    } catch (error) {
      return { kind: "unopenable", satnum: command.satnum, reason: error instanceof Error ? error.message : String(error) };
    }
    cache.set(command.satnum, orbit);
  }

  const start = new Date(command.startEpochMs);
  const end = new Date(command.endEpochMs);
  const passes: WorkerPass[] = [];
  for (const station of command.stations) {
    const found: WorkerPass[] =
      command.mode === "swath" ? orbit.computePassesSwath(station.position, command.swath, start, end) : orbit.computePassesElevation(station.position, start, end);
    for (const pass of found) {
      pass.groundStationName = station.name;
      passes.push(pass);
    }
  }
  passes.sort((a, b) => a.start - b.start);
  return { kind: "passes", satnum: command.satnum, passes };
}

/** Guarded on the absence of `window`, not on `self` existing — see sgp4Worker. */
const inWorkerScope = typeof (globalThis as { window?: unknown }).window === "undefined" && typeof (globalThis as { postMessage?: unknown }).postMessage === "function";

if (inWorkerScope) {
  const cache = new OrbitCache();
  self.addEventListener("message", (event: MessageEvent<PassRequest>) => {
    const { batchId, commands } = event.data;
    const replies = commands.map((command) => runPassCommand(cache, command));
    const response: PassResponse = { batchId, replies };
    // DedicatedWorkerGlobalScope.postMessage takes no target origin.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    (self as unknown as { postMessage(message: PassResponse): void }).postMessage(response);
  });
}
