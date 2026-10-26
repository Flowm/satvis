import { Cartesian3, ExtrapolationType, JulianDate, LagrangePolynomialApproximation, Matrix3, ReferenceFrame, TimeInterval, defined } from "@cesium/core";
import { SampledPositionProperty, Transforms } from "@cesium/engine";
import type { InterpolationAlgorithm } from "@cesium/engine";
import type { Viewer } from "@cesium/widgets";

import type Orbit from "./Orbit";
import "./util/CesiumSampledPositionRawValueAccess";
import { CesiumCallbackHelper } from "./util/CesiumCallbackHelper";
import { drawablePositions } from "./util/drawablePositions";
import { GridPositionProperty, type SampleVisitor } from "./util/GridPositionProperty";
import type { SampleChunk, TrajectorySampler } from "./util/sampleSource";
import { trajectoryWindow } from "./util/trajectoryWindow";

/**
 * Cesium 1.143's LagrangePolynomialApproximation typings lag the widened InterpolationAlgorithm interface.
 */
const lagrangeInterpolation = LagrangePolynomialApproximation as unknown as InterpolationAlgorithm;

interface SampledPositionData {
  interval: TimeInterval;
  /** Built on demand (`requireSampled`): a `JulianDate` per sample costs 13.2 KB a satellite. */
  fixed: SampledPositionProperty | undefined;
  /** Built on demand (`requireInertial`) for the Orbit component's path: 21 KB a satellite. */
  inertial: SampledPositionProperty | undefined;
  valid: boolean;
}

/**
 * The far share of the orbit line that takes up its drift. Before it the line is the
 * satellite's own path, so a rebuild up to three quarters of a period late still runs
 * through the satellite. The ramp's turn leaves the largest bend at 3.005° for the ISS
 * and 3.26° for NOAA 20, whose drift lies along the orbit; 120 samples an orbit bend 3°.
 */
const DRIFT_RAMP_SHARE = 0.25;

/** One satellite's sliding sample window: half an orbit back, 1.5 forward, in the fixed and inertial frames. */
export class SampledTrajectory {
  #orbit: Orbit;

  #data: SampledPositionData | undefined;

  #wantsInertial = false;

  #wantsSampled = false;

  readonly #sampler: TrajectorySampler;

  /**
   * The authoritative fixed-frame store; `fixed` and `inertial` are built from it.
   * At 5,000 satellites it cut `dataSourceDisplay.update` from 12.0 ms to 5.1 ms.
   */
  #gridFixed = new GridPositionProperty();

  /** False after a gap: the grid read assumes no holes, so `fixed` takes over. */
  #gridUsable = true;

  /** The grid while it holds the samples; undefined once `fixed` has taken over, or before a sample. */
  get #grid(): GridPositionProperty | undefined {
    return this.#gridUsable && this.#gridFixed.length > 0 ? this.#gridFixed : undefined;
  }

  /** At most one; see `ensure`. */
  #filling: Promise<void> | undefined;

  #pendingTime: JulianDate | undefined;

  /** Not `!this.#data`: the whole-window fill runs while `#data` is undefined anyway. */
  #stopped = false;

  #unfollow: (() => void) | undefined;

  constructor(orbit: Orbit, sampler: TrajectorySampler) {
    this.#orbit = orbit;
    this.#sampler = sampler;
  }

  get valid(): boolean {
    return this.#data?.valid ?? false;
  }

  /**
   * For path graphics: PathVisualizer samples a `SampledPositionProperty` at its
   * own sample times, anything else at the coarser `resolution`. Undefined until
   * `requireSampled`.
   */
  get fixed(): SampledPositionProperty | undefined {
    return this.#data?.fixed;
  }

  /** Idempotent. Backfills from the grid without SGP4 or frame transforms. */
  requireSampled(): void {
    if (this.#wantsSampled) {
      return;
    }
    this.#wantsSampled = true;
    this.#backfillSampled();
  }

  #backfillSampled(): void {
    const data = this.#data;
    if (!data || data.fixed) {
      return;
    }
    const fixed = SampledTrajectory.#createProperty(ReferenceFrame.FIXED);
    const { times, positions } = this.#windowSamples();
    if (times.length > 0) {
      fixed.addSamples(times, positions);
    }
    data.fixed = fixed;
  }

  /** From the grid, or from `fixed` once a gap has abandoned the grid. */
  #windowSamples(): { times: JulianDate[]; positions: Cartesian3[] } {
    const grid = this.#grid;
    if (grid) {
      return grid.allSamples();
    }
    const fixed = this.#data?.fixed;
    if (!fixed) {
      return { times: [], positions: [] };
    }
    const { times, values } = fixed.getRawSamples();
    return { times, positions: values as Cartesian3[] };
  }

  get sampleCount(): number {
    return this.#grid?.length ?? this.#data?.fixed?.length() ?? 0;
  }

  #positionsBetween(start: JulianDate, end: JulianDate): Cartesian3[] {
    const grid = this.#grid;
    if (grid) {
      return grid.samplesBetween(start, end).positions;
    }
    const fixed = this.#data?.fixed;
    return fixed ? (fixed.getRawValues(start, end) as Cartesian3[]) : [];
  }

  /** For "where is it now" reads. Path graphics use `fixed` instead. */
  get entityPosition(): GridPositionProperty | SampledPositionProperty | undefined {
    if (!this.#data) {
      return undefined;
    }
    return this.#grid ?? this.#data.fixed;
  }

  /** ICRF. Undefined until `requireInertial`. */
  get inertial(): SampledPositionProperty | undefined {
    return this.#data?.inertial;
  }

  /** Idempotent, before or after `start`. Backfills with one frame transform per sample, no SGP4. */
  requireInertial(): void {
    if (this.#wantsInertial) {
      return;
    }
    this.#wantsInertial = true;
    this.#backfillInertial();
  }

  #backfillInertial(): void {
    const data = this.#data;
    if (!data || data.inertial) {
      return;
    }
    const inertial = SampledTrajectory.#createProperty(ReferenceFrame.INERTIAL);
    const { times, positions: values } = this.#windowSamples();
    const positions: Cartesian3[] = [];
    const kept: JulianDate[] = [];
    for (const [index, time] of times.entries()) {
      const fixedToIcrf = Transforms.computeFixedToIcrfMatrix(time);
      if (!defined(fixedToIcrf)) {
        continue;
      }
      kept.push(time);
      positions.push(Matrix3.multiplyByVector(fixedToIcrf, values[index] as Cartesian3, new Cartesian3()));
    }
    if (kept.length > 0) {
      inertial.addSamples(kept, positions);
    }
    data.inertial = inertial;
  }

  get interval(): TimeInterval | undefined {
    return this.#data?.interval;
  }

  /** Fixed frame. */
  position(time: JulianDate): Cartesian3 | undefined {
    return this.entityPosition?.getValue(time);
  }

  /**
   * The inertial orbit one period ahead of `start`, closed into a loop at the satellite. A
   * period on, J2 has moved the orbit (31 km for the ISS, 54 km for NOAA 20), and closing
   * straight back bent the line up to 95°, so the drift is ramped out over the last quarter.
   * After a clock jump or a gap it is the head alone, which the caller skips until the refill.
   * Rotated from the fixed samples: an `inertial` property for every batched orbit took 354 MB
   * for all active ones.
   */
  positionsForNextOrbit(start: JulianDate): Cartesian3[] {
    const last = this.#lastSampleTime();
    if (!this.#data || !last) return [];
    const periodSeconds = this.#orbit.orbitalPeriod * 60;
    const end = JulianDate.addSeconds(start, periodSeconds, new JulianDate());
    const head = this.#inertialAt(start);
    if (!head) return [];
    const { times, positions: fixedPositions } = this.samplesBetween(start, end);
    const kept: JulianDate[] = [];
    const positions: Cartesian3[] = [];
    for (const [index, time] of times.entries()) {
      const fixedToIcrf = Transforms.computeFixedToIcrfMatrix(time, SampledTrajectory.#rotationScratch);
      if (defined(fixedToIcrf)) {
        kept.push(time);
        positions.push(Matrix3.multiplyByVector(fixedToIcrf, fixedPositions[index] as Cartesian3, fixedPositions[index] as Cartesian3));
      }
    }
    // Measured a period back from the last sample when `end` is past it, where
    // interpolation would hold that sample instead. The drift barely changes in between.
    const measuredAt = JulianDate.lessThan(end, last) ? end : last;
    const after = this.#inertialAt(measuredAt);
    const before = this.#inertialAt(JulianDate.addSeconds(measuredAt, -periodSeconds, new JulianDate()));
    if (after && before) {
      const drift = Cartesian3.subtract(after, before, new Cartesian3());
      const rampSeconds = periodSeconds * DRIFT_RAMP_SHARE;
      const shift = new Cartesian3();
      for (const [index, position] of positions.entries()) {
        const weight = (JulianDate.secondsDifference(kept[index]!, start) - periodSeconds + rampSeconds) / rampSeconds;
        if (weight > 0) {
          Cartesian3.subtract(position, Cartesian3.multiplyByScalar(drift, weight, shift), position);
        }
      }
    }
    return drawablePositions([head, ...positions, head]);
  }

  /** The fixed-to-ICRF rotation of one sample, reused for the next. */
  static readonly #rotationScratch = new Matrix3();

  /** ICRF, interpolated in the fixed frame; undefined outside the samples or before the IAU data loads. */
  #inertialAt(time: JulianDate): Cartesian3 | undefined {
    const fixed = this.position(time);
    const fixedToIcrf = fixed && Transforms.computeFixedToIcrfMatrix(time, SampledTrajectory.#rotationScratch);
    return fixed && defined(fixedToIcrf) ? Matrix3.multiplyByVector(fixedToIcrf, fixed, fixed) : undefined;
  }

  /** The time of the window's last sample; undefined without one. */
  #lastSampleTime(): JulianDate | undefined {
    const grid = this.#grid;
    if (grid) {
      return grid.timeAt(grid.firstIndex + grid.length - 1);
    }
    return this.#data?.fixed?.lastTime();
  }

  /**
   * One orbit ahead of `start`, from the raw samples. The head is interpolated: the
   * first sample can sit a step (about 45 s, 350 km) ahead of the satellite. A lone head
   * is skipped as in `positionsForNextOrbit`.
   */
  positionsForTrack(start: JulianDate): Cartesian3[] {
    if (!this.#data) return [];
    const end = JulianDate.addSeconds(start, this.#orbit.orbitalPeriod * 60, new JulianDate());
    // The grid always exists, so the fixed path never creates a sampled property.
    return drawablePositions([this.position(start), ...this.#positionsBetween(start, end)]);
  }

  /** Each fixed-frame sample of the window and its seconds after `time`, for the render pacer. */
  forEachSample(time: JulianDate, visit: SampleVisitor): void {
    const grid = this.#grid;
    if (grid) {
      grid.forEachSample(time, visit);
      return;
    }
    const fixed = this.#data?.fixed;
    const interval = this.#data?.interval;
    if (!fixed || !interval) {
      return;
    }
    const { times, values } = fixed.getRawSamples(interval.start, interval.stop);
    for (const [index, position] of (values as Cartesian3[]).entries()) {
      visit(position.x, position.y, position.z, JulianDate.secondsDifference(times[index]!, time));
    }
  }

  /** The raw fixed-frame samples from `start` to `end`, for the ground track's ribbon. */
  samplesBetween(start: JulianDate, end: JulianDate): { times: JulianDate[]; positions: Cartesian3[] } {
    const grid = this.#grid;
    if (grid) {
      return grid.samplesBetween(start, end);
    }
    const fixed = this.#data?.fixed;
    if (!fixed) {
      return { times: [], positions: [] };
    }
    const { times, values } = fixed.getRawSamples(start, end);
    return { times, positions: values as Cartesian3[] };
  }

  /**
   * Takes the opening window the build fetched. The interval is the chunk's own
   * extent; the first `ensure` tops up to the policy window.
   */
  adopt(chunk: SampleChunk): void {
    const sampleCount = Math.floor(chunk.positionsFixed.length / 3);
    if (this.#data || this.#stopped || sampleCount === 0) {
      return;
    }
    const start = SampledTrajectory.#sampleTime(chunk, 0);
    const stop = SampledTrajectory.#sampleTime(chunk, sampleCount - 1);
    this.#init(start);
    this.#applyChunk(chunk);
    this.#setInterval(new TimeInterval({ start, stop }));
  }

  /**
   * The bounds are approximate; the sampler answers on a grid anchored to the
   * epoch. At most one request is outstanding: otherwise, at 5,000 satellites and
   * x10000, the sampler made 2.5 million samples a second where 1.1 million suffice.
   */
  ensure(time: JulianDate): Promise<void> {
    if (this.#filling) {
      // Keep only the latest time: a queue grows at a fast clock, and a drop loses a jump.
      this.#pendingTime = time;
      return this.#filling;
    }
    this.#filling = this.#fill(time).finally(() => {
      this.#filling = undefined;
      const pending = this.#pendingTime;
      this.#pendingTime = undefined;
      if (pending) {
        void this.ensure(pending);
      }
    });
    return this.#filling;
  }

  async #fill(time: JulianDate): Promise<void> {
    const window = trajectoryWindow(this.#orbit.orbitalPeriod);
    if (window.sampleCount === 0) {
      return;
    }
    const request = new TimeInterval({
      start: JulianDate.addSeconds(time, window.offsetSeconds, new JulianDate()),
      stop: JulianDate.addSeconds(time, window.offsetSeconds + window.spanSeconds, new JulianDate()),
    });

    // Nothing held, or the clock jumped clear of it: request the whole window.
    if (!this.#data || !TimeInterval.contains(this.#data.interval, time)) {
      const chunk = await this.#sampler.samples(JulianDate.toDate(request.start).getTime(), JulianDate.toDate(request.stop).getTime());
      // Torn down while the request was in flight.
      if (!chunk || chunk.positionsFixed.length === 0 || this.#stopped) {
        return;
      }
      this.#init(request.start);
      this.#applyChunk(chunk);
      this.#setInterval(request);
      return;
    }

    const held = this.#data.interval;
    const missingBefore = JulianDate.secondsDifference(held.start, request.start) > 0;
    const missingAfter = JulianDate.secondsDifference(request.stop, held.stop) > 0;
    const chunks = await Promise.all([
      missingBefore ? this.#sampler.samples(JulianDate.toDate(request.start).getTime(), JulianDate.toDate(held.start).getTime()) : undefined,
      missingAfter ? this.#sampler.samples(JulianDate.toDate(held.stop).getTime(), JulianDate.toDate(request.stop).getTime()) : undefined,
    ]);
    // Torn down while the request was in flight.
    if (!this.#data) {
      return;
    }
    for (const chunk of chunks) {
      if (chunk) this.#applyChunk(chunk);
    }
    this.#evict(request);
    this.#data.interval = request;
  }

  /**
   * The chunk arrives in the fixed frame, so without `fixed` or `inertial` this is a
   * typed-array copy. ICRF stays here: its IAU data lives only on the main thread.
   * Refused samples are skipped, not retried; they would fail the same way.
   */
  #applyChunk(chunk: SampleChunk): void {
    const data = this.#data;
    if (!data) {
      return;
    }
    const arrived = chunk.positionsFixed;
    const sampleCount = Math.floor(arrived.length / 3);
    const refused = chunk.refusedIndices.length > 0 ? new Set(chunk.refusedIndices) : undefined;
    const inertialProperty = data.inertial;

    // Refusals take the slow path: the gap branch creates `fixed`, which needs the pairs.
    if (inertialProperty === undefined && data.fixed === undefined && refused === undefined) {
      if (sampleCount > 0) {
        this.#addToGrid(chunk, arrived, false);
      }
      return;
    }

    const anchor = SampledTrajectory.#chunkAnchor(chunk);
    const sampledTimes: JulianDate[] = [];
    const sampledPositions: Cartesian3[] = [];
    const sampledInertial: Cartesian3[] = [];
    const keptPositions = new Float64Array(sampleCount * 3);
    let kept = 0;

    for (let index = 0; index < sampleCount; index += 1) {
      if (refused?.has(index)) {
        continue;
      }
      const offset = index * 3;
      const time = SampledTrajectory.#sampleTimeFrom(anchor, chunk, index);
      const position = new Cartesian3(arrived[offset] as number, arrived[offset + 1] as number, arrived[offset + 2] as number);
      if (inertialProperty) {
        const fixedToIcrf = Transforms.computeFixedToIcrfMatrix(time);
        if (!defined(fixedToIcrf)) {
          if (data.valid) {
            console.error("Reference frame transformation data failed to load");
            data.valid = false;
          }
          continue;
        }
        sampledInertial.push(Matrix3.multiplyByVector(fixedToIcrf, position, new Cartesian3()));
      }
      sampledTimes.push(time);
      sampledPositions.push(position);

      const at = kept * 3;
      keptPositions[at] = position.x;
      keptPositions[at + 1] = position.y;
      keptPositions[at + 2] = position.z;
      kept += 1;
    }

    if (kept === 0) {
      return;
    }
    // Grid first: a gap creates `fixed`, whose backfill must read the grid before this
    // chunk. Any shortfall is a gap, so `keptPositions` is only read when it is full.
    this.#addToGrid(chunk, keptPositions, kept !== sampleCount);
    this.#data?.fixed?.addSamples(sampledTimes, sampledPositions);
    inertialProperty?.addSamples(sampledTimes, sampledInertial);
  }

  /**
   * A gap abandons the grid rather than interpolating across 45 s. The next refresh
   * rebinds the entities (SatelliteComponentCollection's `#bindAll`).
   */
  #addToGrid(chunk: SampleChunk, fixedFlat: Float64Array, hadGaps: boolean): void {
    if (!this.#gridUsable) {
      return;
    }
    if (hadGaps) {
      // Order matters: the backfill must read the grid before `#gridUsable` turns false.
      this.requireSampled();
      this.#gridUsable = false;
      this.#gridFixed.clear();
      return;
    }
    if (!this.#gridFixed.isOnGrid(chunk.anchorEpochMs, chunk.stepSeconds)) {
      this.#gridFixed.reset(chunk.anchorEpochMs, chunk.stepSeconds);
    }
    if (!this.#gridFixed.add(chunk.firstIndex, fixedFlat)) {
      // Not contiguous (a clock jump): restart the grid from this chunk.
      this.#gridFixed.reset(chunk.anchorEpochMs, chunk.stepSeconds);
      this.#gridFixed.add(chunk.firstIndex, fixedFlat);
    }
  }

  /** Its own method so the caller's narrowing of `#data` does not reach in here. */
  #setInterval(interval: TimeInterval): void {
    if (this.#data) {
      this.#data.interval = interval;
    }
  }

  /**
   * Keep out of the per-sample loop: per sample it cost 1.2 million `Date`s and as many
   * `JulianDate`s at 5,000 satellites.
   */
  static #chunkAnchor(chunk: SampleChunk): JulianDate {
    return JulianDate.fromDate(new Date(chunk.anchorEpochMs));
  }

  /**
   * From the shared anchor, so one grid index always yields one instant (see Sgp4Chunk.anchorEpochMs).
   */
  static #sampleTimeFrom(anchor: JulianDate, chunk: SampleChunk, index: number): JulianDate {
    return JulianDate.addSeconds(anchor, (chunk.firstIndex + index) * chunk.stepSeconds, new JulianDate());
  }

  static #sampleTime(chunk: SampleChunk, index: number): JulianDate {
    return SampledTrajectory.#sampleTimeFrom(SampledTrajectory.#chunkAnchor(chunk), chunk, index);
  }

  #evict(keep: TimeInterval): void {
    const data = this.#data;
    if (!data) {
      return;
    }
    const before = new TimeInterval({ start: JulianDate.fromIso8601("1957"), stop: keep.start, isStartIncluded: false, isStopIncluded: false });
    const after = new TimeInterval({ start: keep.stop, stop: JulianDate.fromIso8601("2100"), isStartIncluded: false, isStopIncluded: false });
    data.fixed?.removeSamples(before);
    data.fixed?.removeSamples(after);
    data.inertial?.removeSamples(before);
    data.inertial?.removeSamples(after);
    if (this.#gridFixed.length > 0) {
      this.#gridFixed.dropBefore(this.#gridFixed.indexAtOrAfter(keep.start));
      this.#gridFixed.dropAfter(this.#gridFixed.indexAtOrAfter(keep.stop));
    }
  }

  /**
   * Keeps the window fresh as the viewer's clock moves, until `stop`, and calls
   * `onRefill` after each top-up. Schedules only: the opening window is `adopt`ed.
   */
  follow(viewer: Viewer, onRefill: () => void): void {
    if (this.#stopped || this.#unfollow) {
      return;
    }
    const samplingRefreshRate = (this.#orbit.orbitalPeriod * 60) / 4;
    this.#unfollow = CesiumCallbackHelper.createPeriodicTimeCallback(viewer, samplingRefreshRate, (time) => {
      void this.ensure(time).then(() => {
        // Stopped while the top-up was in flight.
        if (this.#data) onRefill();
      });
    });
  }

  /** Final: drops the samples and ends the top-ups, so a stopped trajectory stays empty. */
  stop(): void {
    this.#unfollow?.();
    this.#unfollow = undefined;
    this.#stopped = true;
    this.#data = undefined;
    this.#pendingTime = undefined;
  }

  static #createProperty(referenceFrame?: ReferenceFrame): SampledPositionProperty {
    const property = new SampledPositionProperty(referenceFrame);
    property.backwardExtrapolationType = ExtrapolationType.HOLD;
    property.forwardExtrapolationType = ExtrapolationType.HOLD;
    property.setInterpolationOptions({
      interpolationDegree: 5,
      interpolationAlgorithm: lagrangeInterpolation,
    });
    return property;
  }

  #init(currentTime: JulianDate): void {
    this.#gridUsable = true;
    this.#data = {
      interval: new TimeInterval({
        start: currentTime,
        stop: currentTime,
        isStartIncluded: false,
        isStopIncluded: false,
      }),
      fixed: this.#wantsSampled ? SampledTrajectory.#createProperty() : undefined,
      inertial: this.#wantsInertial ? SampledTrajectory.#createProperty(ReferenceFrame.INERTIAL) : undefined,
      valid: true,
    };
  }
}
