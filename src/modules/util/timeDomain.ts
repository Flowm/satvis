// Which frames a time-dependent imagery layer has, in GIBS's notation
// (`start/end/PT10M,…`) parsed to epoch milliseconds, and which one to show when.

export interface TimeRange {
  start: number;
  end: number;
  /** Zero for a range holding a single frame. */
  step: number;
}

/** One interval of a window: from `start` until the next step's start, show `frame`. */
export interface FrameStep {
  start: number;
  frame: number;
}

const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

function durationMs(duration: string): number | undefined {
  const match = DURATION.exec(duration);
  if (!match) {
    return undefined;
  }
  const [, days = "0", hours = "0", minutes = "0", seconds = "0"] = match;
  const ms = (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
  return ms > 0 ? ms : undefined;
}

/** The comma-separated ranges of a GIBS `<Domain>`, sorted. Malformed entries are skipped. */
export function parseDomain(text: string): TimeRange[] {
  const ranges: TimeRange[] = [];
  for (const entry of text.split(",")) {
    const parts = entry.trim().split("/");
    const start = Date.parse(parts[0] ?? "");
    if (Number.isNaN(start)) {
      continue;
    }
    if (parts.length === 1) {
      ranges.push({ start, end: start, step: 0 });
      continue;
    }
    const end = Date.parse(parts[1] ?? "");
    const step = durationMs(parts[2] ?? "");
    if (Number.isNaN(end) || end < start || step === undefined) {
      continue;
    }
    ranges.push({ start, end, step });
  }
  return ranges.toSorted((a, b) => a.start - b.start);
}

/**
 * The frame to show at `time`: the latest one at or before it, so a gap holds the
 * frame before it, or the earliest when `time` precedes them all.
 */
export function snapToFrame(ranges: readonly TimeRange[], time: number): number | undefined {
  const range = ranges.findLast((candidate) => candidate.start <= time);
  if (!range) {
    return ranges[0]?.start;
  }
  if (time >= range.end || range.step === 0) {
    return range.end;
  }
  return range.start + Math.floor((time - range.start) / range.step) * range.step;
}

/**
 * The frames for `slots` steps either side of `center`, merged where consecutive steps
 * show the same frame. Steps are aligned to multiples of `stepMs` since the epoch, which
 * is where GIBS puts both its 10-minute and its daily frames.
 */
export function frameWindow(ranges: readonly TimeRange[], center: number, stepMs: number, slots: number): FrameStep[] {
  const first = (Math.floor(center / stepMs) - slots) * stepMs;
  const steps: FrameStep[] = [];
  for (let slot = 0; slot <= 2 * slots && ranges.length > 0; slot += 1) {
    const start = first + slot * stepMs;
    const frame = snapToFrame(ranges, start)!;
    if (steps.at(-1)?.frame !== frame) {
      steps.push({ start, frame });
    }
  }
  return steps;
}

/** A frame as GIBS names it in a tile url: `2026-10-05` for a daily layer, else to the second. */
export function formatFrame(frame: number, daily: boolean): string {
  const iso = new Date(frame).toISOString();
  return daily ? iso.slice(0, 10) : `${iso.slice(0, 19)}Z`;
}
