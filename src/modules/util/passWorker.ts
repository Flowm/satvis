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
 * One command per satellite, so a reply means "this satellite is done". It carries the
 * record every time: an `sgp4init` took 1.5 µs against 5-6 ms for one station's search.
 */
export interface PassCommand {
  kind: "passes";
  /** The satellite's, which its passes carry. */
  name: string;
  record: GpRecord;
  /** "elevation" (line-of-sight) or "swath" (sensor footprint). */
  mode: string;
  stations: PassStation[];
  startEpochMs: number;
  endEpochMs: number;
  swath: SwathExtents;
}

export type PassReply =
  | { kind: "passes"; passes: WorkerPass[] }
  // No retry will help.
  | { kind: "unopenable"; reason: string };

export interface PassRequest {
  batchId: number;
  commands: PassCommand[];
}

export interface PassResponse {
  batchId: number;
  replies: PassReply[];
}

/** Shared by the worker and the inline source. */
export function runPassCommand(command: PassCommand): PassReply {
  let orbit: Orbit;
  try {
    orbit = new Orbit(command.name, command.record);
  } catch (error) {
    return { kind: "unopenable", reason: error instanceof Error ? error.message : String(error) };
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
  return { kind: "passes", passes };
}

/** Guarded on the absence of `window`, not on `self` existing — see sgp4Worker. */
const inWorkerScope = typeof (globalThis as { window?: unknown }).window === "undefined" && typeof (globalThis as { postMessage?: unknown }).postMessage === "function";

if (inWorkerScope) {
  self.addEventListener("message", (event: MessageEvent<PassRequest>) => {
    const { batchId, commands } = event.data;
    const replies = commands.map((command) => runPassCommand(command));
    const response: PassResponse = { batchId, replies };
    // DedicatedWorkerGlobalScope.postMessage takes no target origin.
    // eslint-disable-next-line unicorn/require-post-message-target-origin
    (self as unknown as { postMessage(message: PassResponse): void }).postMessage(response);
  });
}
