import { JulianDate, TimeInterval, TimeIntervalCollection } from "@cesium/engine";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

import type { SwathExtents } from "../config/satelliteMetadata";
import type Orbit from "./Orbit";
import type { GroundStationPosition } from "./Orbit";
import type { PassPredictorSource, WorkerPass } from "./util/passSource";

dayjs.extend(utc);

export type Pass = WorkerPass;

export interface GroundStation {
  name: string;
  position: GroundStationPosition;
}

/** One rendered row of the passes table in the entity info panel. */
export interface PassRow {
  key: string;
  name: string;
  countdown: string;
  startLabel: string;
  endLabel: string;
  /** Max elevation (elevation mode) or min distance (swath mode). */
  primary: string;
  /** Azimuth at apex (elevation mode) or swath width (swath mode). */
  secondary: string;
  /** Epoch ms. The row's identity: the panel matches passes by start time, not by index. */
  startMs: number;
}

interface PassWindow {
  start: JulianDate;
  stop: JulianDate;
  stopPrediction: JulianDate;
}

/**
 * Pass prediction for one satellite. Setting `groundStations` or `mode`
 * invalidates the window. Prediction runs off-thread (8 ms of SGP4 per satellite
 * per station), so `passes(time)` never blocks: a stale read returns the previous
 * list, or nothing at first, and `onChanged` fires when the answer lands.
 */
export class PassPredictor {
  #orbit: Orbit;

  /** Read per recompute, so a record that arrives later still applies. */
  #swath: () => SwathExtents;

  #groundStations: GroundStation[] = [];

  #mode = "elevation";

  #passes: Pass[] = [];

  #window: PassWindow | undefined;

  readonly #source: PassPredictorSource;

  #requesting = false;

  #pendingTime: JulianDate | undefined;

  #inFlight: Promise<void> | undefined;

  /** Bumped by `clear()`; a reply from an older generation is dropped. */
  #generation = 0;

  #listeners = new Set<() => void>();

  passIntervals = new TimeIntervalCollection();

  constructor(orbit: Orbit, swath: () => SwathExtents, source: PassPredictorSource) {
    this.#orbit = orbit;
    this.#swath = swath;
    this.#source = source;
  }

  /** Returns an unsubscribe. */
  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  get groundStations(): GroundStation[] {
    return this.#groundStations;
  }

  set groundStations(groundStations: GroundStation[]) {
    this.#groundStations = groundStations;
    this.clear();
  }

  get groundStationAvailable(): boolean {
    return this.#groundStations.length > 0;
  }

  get mode(): string {
    return this.#mode;
  }

  /** Overpass mode: "elevation" (line-of-sight) or "swath" (sensor footprint). */
  set mode(mode: string) {
    if (mode === this.#mode) {
      return;
    }
    this.#mode = mode;
    this.clear();
  }

  /** Recomputes only when `time` leaves the window: ±1 day around the last compute, predicting 4 days ahead. */
  passes(time: JulianDate): Pass[] {
    if (!this.groundStationAvailable) {
      return this.#passes;
    }
    if (this.#covers(time)) {
      return this.#passes;
    }
    void this.#request(time);
    return this.#passes;
  }

  /**
   * Tells "no passes" from "not predicted yet". True without a ground station,
   * since there is nothing to wait for.
   */
  settled(time: JulianDate): boolean {
    return !this.groundStationAvailable || this.#covers(time);
  }

  /** Resolves once the list covers `time`. */
  ensurePasses(time: JulianDate): Promise<Pass[]> {
    if (!this.groundStationAvailable) {
      return Promise.resolve(this.#passes);
    }
    if (this.#covers(time)) {
      return Promise.resolve(this.#passes);
    }
    return this.#request(time).then(() => this.#passes);
  }

  clear(): void {
    this.#window = undefined;
    this.#passes = [];
    this.#generation += 1;
    this.passIntervals = new TimeIntervalCollection();
  }

  /**
   * At most one request at a time. A read during a request is not queued, since
   * at a fast clock reads outrun replies; its time is re-asked once afterwards.
   */
  #request(time: JulianDate): Promise<void> {
    if (this.#requesting) {
      this.#pendingTime = JulianDate.clone(time);
      // Not a resolved promise, which would hand `ensurePasses` the stale list.
      return this.#inFlight ?? Promise.resolve();
    }
    this.#requesting = true;
    const generation = this.#generation;
    const window: PassWindow = {
      start: JulianDate.addDays(time, -1, JulianDate.clone(time)),
      stop: JulianDate.addDays(time, 1, JulianDate.clone(time)),
      stopPrediction: JulianDate.addDays(time, 4, JulianDate.clone(time)),
    };
    this.#inFlight = this.#source
      .passes({
        mode: this.#mode,
        stations: this.#groundStations.map((station) => ({ name: station.name, position: station.position })),
        startEpochMs: JulianDate.toDate(window.start).getTime(),
        endEpochMs: JulianDate.toDate(window.stopPrediction).getTime(),
        swath: this.#swath(),
      })
      .then((passes) => {
        if (generation !== this.#generation || passes === undefined) {
          return;
        }
        this.#apply(window, passes);
      })
      .finally(() => {
        this.#requesting = false;
        this.#inFlight = undefined;
        const pending = this.#pendingTime;
        this.#pendingTime = undefined;
        // Without the coverage check every reply spawned another prediction, forever.
        if (pending && !this.#covers(pending)) {
          void this.#request(pending);
        }
      });
    return this.#inFlight;
  }

  #covers(time: JulianDate): boolean {
    return this.#window !== undefined && TimeInterval.contains(new TimeInterval({ start: this.#window.start, stop: this.#window.stop }), time);
  }

  #apply(window: PassWindow, passes: Pass[]): void {
    // The worker is keyed on satnum and holds no name. See OrbitCache.
    for (const pass of passes) {
      pass.name = this.#orbit.name;
    }
    this.#window = window;
    this.#passes = passes;
    this.passIntervals = new TimeIntervalCollection(
      passes.map(
        (pass) =>
          new TimeInterval({
            start: JulianDate.fromDate(new Date(pass.start)),
            stop: JulianDate.fromDate(new Date(pass.end)),
          }),
      ),
    );
    this.#listeners.forEach((listener) => listener());
  }
}

export function stationPassesSettled(predictors: readonly PassPredictor[], time: JulianDate): boolean {
  return predictors.every((predictor) => predictor.settled(time));
}

/** Passes over the named station starting within `deltaHours`, sorted by start time. */
export function stationPasses(predictors: PassPredictor[], time: JulianDate, stationName: string, deltaHours = 48): Pass[] {
  const timeDate = JulianDate.toDate(time);
  return predictors
    .flatMap((predictor) => predictor.passes(time))
    .filter((pass) => dayjs(pass.start).diff(timeDate, "hours") < deltaHours && pass.groundStationName === stationName)
    .toSorted((a, b) => a.start - b.start);
}

/** Ongoing and upcoming passes, or all of them with `showPast`. */
export function filterPasses(passes: Pass[], time: JulianDate, showPast: boolean): Pass[] {
  if (showPast) {
    return passes;
  }
  const start = dayjs(JulianDate.toDate(time));
  return passes.filter((pass) => dayjs(pass.end).isAfter(start));
}

/** "3 h 27 m", "42 s", "ongoing" or "ended": two units at most, so a distant countdown does not tick every second. */
export function formatCountdown(nowMs: number, pass: Pass): string {
  if (pass.end < nowMs) {
    return "ended";
  }
  if (pass.start <= nowMs) {
    return "ongoing";
  }
  const seconds = Math.floor((pass.start - nowMs) / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} m ${seconds % 60} s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ${minutes % 60} m`;
  }
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

/** `Pass.duration` is in milliseconds. */
export function passMinutes(pass: Pass): number {
  return Math.round(pass.duration / 60_000);
}

export function hhmmUtc(epochMs: number): string {
  return dayjs.utc(epochMs).format("HH:mm");
}

/** 0..1: max elevation over 90°, or in swath mode how close to the footprint centre the station falls. */
export function passQuality(pass: Pass): number {
  if ("maxElevation" in pass) {
    return Math.min(1, Math.max(0, pass.maxElevation / 90));
  }
  return Math.min(1, Math.max(0, 1 - pass.minDistance / Math.max(1, pass.swathWidth / 2)));
}

export function passSummary(pass: Pass): string {
  const window = `${hhmmUtc(pass.start)}–${hhmmUtc(pass.end)} UTC · ${passMinutes(pass)} min`;
  if ("maxElevation" in pass) {
    return `${window} · ${pass.maxElevation.toFixed(0)}° max, apex ${compassPoint(pass.azimuthApex)}`;
  }
  return `${window} · ${pass.minDistance.toFixed(0)} km off track, swath ${pass.swathWidth.toFixed(0)} km`;
}

/** 16-point compass abbreviation. */
export function compassPoint(azimuthDeg: number): string {
  const points = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return points[Math.round((((azimuthDeg % 360) + 360) % 360) / 22.5) % 16]!;
}

export function toPassRows(passes: Pass[], time: JulianDate, nameField: "name" | "groundStationName", mode: string): PassRow[] {
  const nowMs = JulianDate.toDate(time).getTime();
  return passes.map((pass) => {
    let primary: string;
    let secondary: string;
    if (mode === "swath" && "minDistance" in pass) {
      primary = `${pass.minDistance.toFixed(1)}km`;
      secondary = `${pass.swathWidth.toFixed(0)}km`;
    } else if ("maxElevation" in pass) {
      primary = `${pass.maxElevation.toFixed(0)}°`;
      secondary = `${pass.azimuthApex.toFixed(2)}°`;
    } else {
      primary = "";
      secondary = "";
    }
    const name = pass[nameField] ?? "";
    return {
      key: `${name}-${pass.start}-${pass.end}`,
      name,
      countdown: formatCountdown(nowMs, pass),
      startLabel: dayjs.utc(pass.start).format("DD.MM HH:mm:ss"),
      endLabel: dayjs.utc(pass.end).format("HH:mm:ss"),
      primary,
      secondary,
      startMs: pass.start,
    };
  });
}
