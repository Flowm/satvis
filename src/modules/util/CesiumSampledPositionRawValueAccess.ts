import { SampledPositionProperty, binarySearch, JulianDate } from "@cesium/engine";

declare module "@cesium/engine" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SampledPositionProperty {
    /** The stored values from `start`, inclusive, to `end`, exclusive. */
    getRawValues(start: JulianDate, end: JulianDate): unknown[];
    /**
     * Each value with its own time, so a caller can transform it into another frame (see
     * SampledTrajectory). Bounded like `getRawValues` when given `start` and `end`.
     */
    getRawSamples(start?: JulianDate, end?: JulianDate): { times: JulianDate[]; values: unknown[] };
    /** Past it, `ExtrapolationType.HOLD` repeats the last value. */
    lastTime(): JulianDate | undefined;
    length(): number;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(SampledPositionProperty.prototype as any).getRawValues = function (this: any, start: JulianDate, end: JulianDate): unknown[] {
  const times = this._property._times;
  if (times.length === 0) {
    return [];
  }
  const innerType = this._property._innerType;
  const values = this._property._values;
  const endIndex = indexAtOrAfter(times, end);
  const result: unknown[] = [];
  for (let i = indexAtOrAfter(times, start); i < endIndex; i += 1) {
    result.push(innerType.unpack(values, i * innerType.packedLength));
  }
  return result;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(SampledPositionProperty.prototype as any).getRawSamples = function (this: any, start?: JulianDate, end?: JulianDate): { times: JulianDate[]; values: unknown[] } {
  const times: JulianDate[] = this._property._times;
  const innerType = this._property._innerType;
  const packed = this._property._values;
  const startIndex = start ? indexAtOrAfter(times, start) : 0;
  const endIndex = end ? indexAtOrAfter(times, end) : times.length;
  const values: unknown[] = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    values.push(innerType.unpack(packed, i * innerType.packedLength));
  }
  return { times: times.slice(startIndex, endIndex), values };
};

/** The first index at or after `time`, or the length. */
function indexAtOrAfter(times: JulianDate[], time: JulianDate): number {
  const index = binarySearch(times, time, JulianDate.compare);
  return index < 0 ? ~index : index;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(SampledPositionProperty.prototype as any).lastTime = function (this: any): JulianDate | undefined {
  return this._property._times.at(-1);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(SampledPositionProperty.prototype as any).length = function (this: any): number {
  return this._property._times.length;
};
