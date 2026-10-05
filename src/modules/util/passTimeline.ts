// Lays out a pass list as a strip, in percentages. Cesium-free so it can be tested.

import { passQuality, type Pass } from "../PassPredictor";

const HOUR_MS = 3600 * 1000;

/** Keeps the "now" marker off the strip's edge, and a just-ended pass visible. */
const LEAD_IN_MS = 30 * 60 * 1000;

/**
 * The span is sized to the passes, not fixed: a fixed 12 h held only two of the
 * ISS's twenty-three passes at 20:30 UTC.
 */
const TARGET_BLOCKS = 6;
const MIN_SPAN_MS = 6 * HOUR_MS;
const MAX_SPAN_MS = 48 * HOUR_MS;

export type PassBand = "high" | "mid" | "low";

/**
 * 0.5 and 0.222 are 45° and 20° of elevation; in swath mode, the same fractions of
 * the way from the footprint edge to its centre.
 */
export function passBand(quality: number): PassBand {
  if (quality >= 0.5) {
    return "high";
  }
  return quality >= 0.222 ? "mid" : "low";
}

export interface TimelineBlock {
  key: string;
  startMs: number;
  /** Percentages, for `left`/`width`/`height`. */
  leftPct: number;
  widthPct: number;
  heightPct: number;
  band: PassBand;
  live: boolean;
  past: boolean;
}

export interface TimelineTick {
  label: string;
  pct: number;
}

export interface TimelineLayout {
  blocks: TimelineBlock[];
  ticks: TimelineTick[];
  nowPct: number;
  /** "7 h", "1.5 d". */
  horizonLabel: string;
  /** How many passes start beyond the strip. */
  beyond: number;
}

/** Blocks are keyed by start time, so a caller can match them to table rows without index alignment. */
export function passTimelineLayout(passes: readonly Pass[], nowMs: number): TimelineLayout {
  const horizonMs = horizonFor(passes, nowMs);
  const spanStart = nowMs - LEAD_IN_MS;
  const spanEnd = nowMs + horizonMs;
  const spanMs = LEAD_IN_MS + horizonMs;
  const pct = (epochMs: number): number => ((epochMs - spanStart) / spanMs) * 100;

  const blocks = passes
    .filter((pass) => pass.end >= spanStart && pass.start <= spanEnd)
    .map((pass) => {
      const left = pct(Math.max(spanStart, pass.start));
      return {
        key: String(pass.start),
        startMs: pass.start,
        leftPct: left,
        // Floored so a short pass on a long strip stays clickable.
        widthPct: Math.max(1.2, pct(Math.min(spanEnd, pass.end)) - left),
        heightPct: 25 + passQuality(pass) * 75,
        band: passBand(passQuality(pass)),
        live: pass.start <= nowMs && pass.end >= nowMs,
        past: pass.end < nowMs,
      };
    });

  return {
    blocks,
    ticks: ticksFor(horizonMs, nowMs, pct),
    nowPct: pct(nowMs),
    horizonLabel: horizonLabel(horizonMs),
    beyond: passes.filter((pass) => pass.start > spanEnd).length,
  };
}

function horizonFor(passes: readonly Pass[], nowMs: number): number {
  const upcoming = passes.filter((pass) => pass.end >= nowMs);
  const last = upcoming[Math.min(TARGET_BLOCKS, upcoming.length) - 1];
  if (!last) {
    return MIN_SPAN_MS;
  }
  // 10% headroom, so the last block is not flush with the edge.
  return Math.min(MAX_SPAN_MS, Math.max(MIN_SPAN_MS, (last.end - nowMs) * 1.1));
}

function ticksFor(horizonMs: number, nowMs: number, pct: (epochMs: number) => number): TimelineTick[] {
  const hours = horizonMs / HOUR_MS;
  const step = [1, 2, 3, 6, 12, 24].find((candidate) => hours / candidate <= 5) ?? 24;
  const ticks: TimelineTick[] = [];
  for (let hour = step; hour < hours; hour += step) {
    const at = pct(nowMs + hour * HOUR_MS);
    // Past 90% the label runs off the right edge of the strip.
    if (at > 90) {
      break;
    }
    ticks.push({ label: `+${hour}h`, pct: at });
  }
  return ticks;
}

function horizonLabel(horizonMs: number): string {
  const hours = horizonMs / HOUR_MS;
  return hours >= 24 ? `${(hours / 24).toFixed(hours % 24 === 0 ? 0 : 1)} d` : `${Math.round(hours)} h`;
}
