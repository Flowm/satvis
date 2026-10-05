import { SampledPositionProperty, binarySearch, JulianDate } from "@cesium/engine";

declare module "@cesium/engine" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SampledPositionProperty {
    getRawValues(start: JulianDate, end: JulianDate): unknown[];
    getRawSamples(): { times: JulianDate[]; values: unknown[] };
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

  let startIndex = binarySearch(times, start, JulianDate.compare);
  let endIndex = binarySearch(times, end, JulianDate.compare);
  if (startIndex < 0) {
    startIndex = ~startIndex;
  }
  if (endIndex < 0) {
    endIndex = ~endIndex;
  }
  const result: unknown[] = [];
  for (let i = startIndex; i < endIndex; i += 1) {
    result.push(innerType.unpack(values, i * innerType.packedLength));
  }
  return result;
};

// Each value with its own time, so a caller can transform it into another frame (see SampledTrajectory).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(SampledPositionProperty.prototype as any).getRawSamples = function (this: any): { times: JulianDate[]; values: unknown[] } {
  const times: JulianDate[] = this._property._times;
  const innerType = this._property._innerType;
  const packed = this._property._values;
  const values: unknown[] = [];
  for (let i = 0; i < times.length; i += 1) {
    values.push(innerType.unpack(packed, i * innerType.packedLength));
  }
  return { times: [...times], values };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(SampledPositionProperty.prototype as any).length = function (this: any): number {
  return this._property._times.length;
};
