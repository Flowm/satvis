// A position property that interpolates over a uniform grid in a flat Float64Array.
// Cesium's SampledPositionProperty pays a bracket search, JulianDate arithmetic and an
// allocation on every read; on a grid anchored to the element-set epoch (see
// sgp4Worker) the bracket is one Math.floor.
//
// Measured A/B/A at 5,000 satellites (this / Cesium / this): dataSourceDisplay.update
// 6.10 / 12.02 / 5.03 ms, fps 99.9 / 71.1 / 96.8. tickMs went 11.08 -> 4.91 ms across
// matched sweeps, and memory 38.7 -> 25.7 KB a satellite, since no JulianDate is kept
// per sample.
//
// Worst error against python-sgp4 (radius and axial component), Cesium's degree-5
// interpolation in brackets: Starlink 4.7 m (4.3), Meteosat 0.1 m (0.0), MMS 1 37.9 m
// (38.5). Lowering Cesium's interpolationDegree instead saves under 1 ms of 12 and
// costs up to 2.5 km.

import { Cartesian3, Event, JulianDate, PositionProperty, ReferenceFrame } from "@cesium/engine";

/** Present at runtime but missing from the published typings. */
const convertToReferenceFrame = (
  PositionProperty as unknown as {
    convertToReferenceFrame(time: JulianDate, value: Cartesian3, inputFrame: ReferenceFrame, outputFrame: ReferenceFrame, result: Cartesian3): Cartesian3 | undefined;
  }
).convertToReferenceFrame;

/**
 * Six samples give a quintic, matching Cesium's degree 5. The step is a fixed
 * fraction of the period, so a cubic was 3.7 km out on MMS 1 (period 3.5 days)
 * where the quintic is 13 m. LEO does not show the difference.
 */
const STENCIL = 6;

const GROWTH_HEADROOM = 1.25;

/**
 * A sample's index is its position on the grid, so batches that share the anchor
 * and step append without matching times.
 */
export class GridPositionProperty {
  readonly #frame: ReferenceFrame;

  /**
   * Public and underscored because Cesium's `VelocityVectorProperty` subscribes via
   * `value._definitionChanged`, not the `definitionChanged` getter.
   */
  readonly _definitionChanged = new Event();

  #anchorEpochMs = 0;

  #stepSeconds = 0;

  /** Grid index of the first sample held. */
  #firstIndex = 0;

  #count = 0;

  /** x, y, z per sample, in `#frame`. */
  #positions = new Float64Array(0);

  #anchor = new JulianDate();

  constructor(referenceFrame: ReferenceFrame = ReferenceFrame.FIXED) {
    this.#frame = referenceFrame;
  }

  get referenceFrame(): ReferenceFrame {
    return this.#frame;
  }

  get isConstant(): boolean {
    return this.#count === 0;
  }

  get definitionChanged(): Event {
    return this._definitionChanged;
  }

  get length(): number {
    return this.#count;
  }

  get stepSeconds(): number {
    return this.#stepSeconds;
  }

  get firstIndex(): number {
    return this.#firstIndex;
  }

  timeAt(gridIndex: number, result?: JulianDate): JulianDate {
    return JulianDate.addSeconds(this.#anchor, gridIndex * this.#stepSeconds, result ?? new JulianDate());
  }

  /** Discards every sample: another anchor or step changes what the indices mean. */
  reset(anchorEpochMs: number, stepSeconds: number): void {
    this.#anchorEpochMs = anchorEpochMs;
    this.#stepSeconds = stepSeconds;
    this.#anchor = JulianDate.fromDate(new Date(anchorEpochMs));
    this.#firstIndex = 0;
    this.#count = 0;
    this._definitionChanged.raiseEvent(this);
  }

  /** Empties the grid and releases its buffer. */
  clear(): void {
    this.#firstIndex = 0;
    this.#count = 0;
    this.#stepSeconds = 0;
    this.#positions = new Float64Array(0);
    this._definitionChanged.raiseEvent(this);
  }

  isOnGrid(anchorEpochMs: number, stepSeconds: number): boolean {
    return this.#count > 0 && this.#anchorEpochMs === anchorEpochMs && this.#stepSeconds === stepSeconds;
  }

  /** Returns false, and adds nothing, for a batch that would leave a hole in the grid. */
  add(gridIndex: number, xyz: Float64Array): boolean {
    const incoming = Math.floor(xyz.length / 3);
    if (incoming === 0) {
      return true;
    }
    if (this.#count === 0) {
      this.#firstIndex = gridIndex;
      this.#ensure(incoming);
      this.#positions.set(xyz.subarray(0, incoming * 3), 0);
      this.#count = incoming;
      this._definitionChanged.raiseEvent(this);
      return true;
    }
    const end = this.#firstIndex + this.#count;
    if (gridIndex > end || gridIndex + incoming < this.#firstIndex) {
      return false;
    }
    if (gridIndex >= this.#firstIndex && gridIndex + incoming <= end) {
      // Wholly inside: the caller re-asked for held samples. Overwrite in place.
      this.#positions.set(xyz.subarray(0, incoming * 3), (gridIndex - this.#firstIndex) * 3);
      return true;
    }
    if (gridIndex < this.#firstIndex) {
      // Extends the front. The overlap is rewritten with the same values.
      const prepend = this.#firstIndex - gridIndex;
      const total = Math.max(end, gridIndex + incoming) - gridIndex;
      this.#ensure(total);
      this.#positions.copyWithin(prepend * 3, 0, this.#count * 3);
      this.#positions.set(xyz.subarray(0, incoming * 3), 0);
      this.#firstIndex = gridIndex;
      this.#count = total;
      this._definitionChanged.raiseEvent(this);
      return true;
    }
    const total = gridIndex - this.#firstIndex + incoming;
    this.#ensure(total);
    this.#positions.set(xyz.subarray(0, incoming * 3), (gridIndex - this.#firstIndex) * 3);
    this.#count = total;
    this._definitionChanged.raiseEvent(this);
    return true;
  }

  dropBefore(gridIndex: number): void {
    const drop = gridIndex - this.#firstIndex;
    if (drop <= 0 || this.#count === 0) {
      return;
    }
    if (drop >= this.#count) {
      this.#firstIndex = gridIndex;
      this.#count = 0;
      return;
    }
    this.#positions.copyWithin(0, drop * 3, this.#count * 3);
    this.#firstIndex = gridIndex;
    this.#count -= drop;
  }

  dropAfter(gridIndex: number): void {
    const keep = gridIndex - this.#firstIndex + 1;
    if (keep < 0) {
      this.#count = 0;
      return;
    }
    if (keep < this.#count) {
      this.#count = keep;
    }
  }

  #ensure(samples: number): void {
    if (this.#positions.length >= samples * 3) {
      return;
    }
    // A refresh appends before the eviction that makes room for it, so 25% headroom
    // settles at a window plus one refresh. Doubling would settle at two windows.
    const grown = new Float64Array(Math.max(Math.ceil(samples * GROWTH_HEADROOM), STENCIL) * 3);
    grown.set(this.#positions.subarray(0, this.#count * 3));
    this.#positions = grown;
  }

  /**
   * Outside the window it holds the end sample, matching the sampled property's
   * HOLD: a polynomial extrapolated past its last node returns nonsense.
   */
  #interpolate(time: JulianDate, result: Cartesian3): Cartesian3 | undefined {
    if (this.#count === 0 || this.#stepSeconds <= 0) {
      return undefined;
    }
    if (this.#count < STENCIL) {
      // Too few samples for the stencil: hold the nearest.
      const nearest = Math.min(this.#count - 1, Math.max(0, Math.round(JulianDate.secondsDifference(time, this.#anchor) / this.#stepSeconds) - this.#firstIndex));
      const at = nearest * 3;
      return Cartesian3.fromElements(this.#positions[at] as number, this.#positions[at + 1] as number, this.#positions[at + 2] as number, result);
    }
    const gridPosition = JulianDate.secondsDifference(time, this.#anchor) / this.#stepSeconds - this.#firstIndex;
    // Centred: the instant sits between nodes 2 and 3 wherever the window allows.
    let base = Math.floor(gridPosition) - 2;
    if (base < 0) {
      base = 0;
    }
    if (base > this.#count - STENCIL) {
      base = this.#count - STENCIL;
    }
    // Clamping u to [0, 5] makes the ends HOLD: there the basis picks the edge sample exactly.
    let u = gridPosition - base;
    if (u < 0) {
      u = 0;
    }
    if (u > STENCIL - 1) {
      u = STENCIL - 1;
    }
    // Lagrange basis for nodes 0..5, expanded; the denominators are constants.
    const d0 = u;
    const d1 = u - 1;
    const d2 = u - 2;
    const d3 = u - 3;
    const d4 = u - 4;
    const d5 = u - 5;
    const b0 = -(d1 * d2 * d3 * d4 * d5) / 120;
    const b1 = (d0 * d2 * d3 * d4 * d5) / 24;
    const b2 = -(d0 * d1 * d3 * d4 * d5) / 12;
    const b3 = (d0 * d1 * d2 * d4 * d5) / 12;
    const b4 = -(d0 * d1 * d2 * d3 * d5) / 24;
    const b5 = (d0 * d1 * d2 * d3 * d4) / 120;
    const p = base * 3;
    const a = this.#positions;
    result.x = (a[p] as number) * b0 + (a[p + 3] as number) * b1 + (a[p + 6] as number) * b2 + (a[p + 9] as number) * b3 + (a[p + 12] as number) * b4 + (a[p + 15] as number) * b5;
    result.y =
      (a[p + 1] as number) * b0 + (a[p + 4] as number) * b1 + (a[p + 7] as number) * b2 + (a[p + 10] as number) * b3 + (a[p + 13] as number) * b4 + (a[p + 16] as number) * b5;
    result.z =
      (a[p + 2] as number) * b0 + (a[p + 5] as number) * b1 + (a[p + 8] as number) * b2 + (a[p + 11] as number) * b3 + (a[p + 14] as number) * b4 + (a[p + 17] as number) * b5;
    return result;
  }

  getValue(time: JulianDate, result?: Cartesian3): Cartesian3 | undefined {
    return this.getValueInReferenceFrame(time, ReferenceFrame.FIXED, result);
  }

  getValueInReferenceFrame(time: JulianDate, referenceFrame: ReferenceFrame, result?: Cartesian3): Cartesian3 | undefined {
    const target = result ?? new Cartesian3();
    if (!this.#interpolate(time, target)) {
      return undefined;
    }
    if (referenceFrame === this.#frame) {
      return target;
    }
    return convertToReferenceFrame(time, target, this.#frame, referenceFrame, target);
  }

  rawPositions(fromGridIndex = this.#firstIndex, toGridIndex = this.#firstIndex + this.#count - 1): Cartesian3[] {
    const from = Math.max(fromGridIndex, this.#firstIndex);
    const to = Math.min(toGridIndex, this.#firstIndex + this.#count - 1);
    const out: Cartesian3[] = [];
    for (let index = from; index <= to; index += 1) {
      const at = (index - this.#firstIndex) * 3;
      out.push(new Cartesian3(this.#positions[at] as number, this.#positions[at + 1] as number, this.#positions[at + 2] as number));
    }
    return out;
  }

  indexAtOrAfter(time: JulianDate): number {
    return Math.ceil(JulianDate.secondsDifference(time, this.#anchor) / this.#stepSeconds);
  }

  /** The times are derived from the anchor, so no JulianDate is kept per sample. */
  samplesBetween(from: JulianDate, to: JulianDate): { times: JulianDate[]; positions: Cartesian3[] } {
    const times: JulianDate[] = [];
    const positions: Cartesian3[] = [];
    if (this.#count === 0 || this.#stepSeconds <= 0) {
      return { times, positions };
    }
    const first = Math.max(this.indexAtOrAfter(from), this.#firstIndex);
    const last = Math.min(Math.floor(JulianDate.secondsDifference(to, this.#anchor) / this.#stepSeconds), this.#firstIndex + this.#count - 1);
    for (let index = first; index <= last; index += 1) {
      const at = (index - this.#firstIndex) * 3;
      times.push(this.timeAt(index));
      positions.push(new Cartesian3(this.#positions[at] as number, this.#positions[at + 1] as number, this.#positions[at + 2] as number));
    }
    return { times, positions };
  }

  allSamples(): { times: JulianDate[]; positions: Cartesian3[] } {
    return this.samplesBetween(this.timeAt(this.#firstIndex), this.timeAt(this.#firstIndex + Math.max(0, this.#count - 1)));
  }

  equals(other?: GridPositionProperty): boolean {
    return this === other;
  }
}
