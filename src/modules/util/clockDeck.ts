// The clock deck's two scales as arithmetic, with no viewer or DOM, so tests can reach them.

import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";

dayjs.extend(utc);

/** The granularity the url records anyway. See CONTEXT.md, live vs pinned time. */
const PRESENT_TOLERANCE_MS = 60_000;

/**
 * Whether the clock shows a moment other than the present. The deck's Live dot goes
 * out on it, and the url pins `time` on it, so the two always agree.
 */
export const isOffPresent = (clockMs: number, systemMs: number): boolean => Math.abs(clockMs - systemMs) > PRESENT_TOLERANCE_MS;

/** An enum, not the app's usual `const` array: nothing iterates it. */
export enum Scale {
  Timeline = "timeline",
  Ladder = "ladder",
}

/**
 * Cesium's `AnimationViewModel.defaultTicks` from 1× up. The thirteen rungs below 1×
 * are left out because a swipe has to cross every rung.
 */
export const SPEED_TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400] as const;

export const LADDER: readonly number[] = [...SPEED_TICKS]
  .toReversed()
  .map((tick) => -tick)
  .concat(SPEED_TICKS);

export const REAL_TIME_RUNG = LADDER.indexOf(1);

/** Also the scroll maths: `scrollLeft / CHIP_PX` is the rung under the needle. */
export const CHIP_PX = 64;

/** 1 hour ≈ 150 px: fine enough to land on a pass, coarse enough that a flick covers a day. */
export const MS_PER_PX = 24_000;
const MINOR_MS = 600_000;
const MAJOR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Simulation ms per real ms, at ~2000 px/s of finger. */
export const MAX_SCRUB_VELOCITY = 48_000;

/** The ladder's, in scroll px per real ms. */
export const MAX_SWIPE_VELOCITY = 4;
export const MIN_SWIPE_VELOCITY = 0.02;

/** Kept per frame at 16.7 ms; one curve for both scales. */
const FLICK_DECAY = 0.94;

export const decayVelocity = (velocity: number, dtMs: number): number => velocity * FLICK_DECAY ** (dtMs / 16.7);

export const clampMagnitude = (value: number, limit: number): number => Math.max(-limit, Math.min(limit, value));

export interface TimelineTick {
  /** Epoch ms. */
  at: number;
  /** Pixels from the timeline's left edge. */
  x: number;
  major: boolean;
  /** Empty on a minor tick; a day boundary reads as its date, not `00:00`. */
  label: string;
}

/** Ten-minute ticks either side of `centreMs`, hours labelled, enough to fill `widthPx`. */
export function timelineTicks(centreMs: number, widthPx: number): TimelineTick[] {
  const half = (widthPx / 2) * MS_PER_PX;
  const first = Math.floor((centreMs - half) / MINOR_MS) * MINOR_MS;
  const ticks: TimelineTick[] = [];
  for (let at = first; at <= centreMs + half; at += MINOR_MS) {
    const major = at % MAJOR_MS === 0;
    ticks.push({
      at,
      x: (at - centreMs) / MS_PER_PX + widthPx / 2,
      major,
      label: major ? (at % DAY_MS === 0 ? dateLabel(new Date(at)) : hhmmLabel(new Date(at))) : "",
    });
  }
  return ticks;
}

/** Epoch milliseconds. */
export interface TimeSpan {
  start: number;
  end: number;
}

/** Pixels from the timeline's left edge. */
export interface PassMark {
  key: string;
  left: number;
  width: number;
}

/** Clipped to the timeline, not dropped: a pass wider than the screen is worth drawing. Minimum a pixel. */
export function passMarks(spans: readonly TimeSpan[], centreMs: number, widthPx: number): PassMark[] {
  const half = (widthPx / 2) * MS_PER_PX;
  const first = centreMs - half;
  const last = centreMs + half;
  const marks: PassMark[] = [];
  for (const span of spans) {
    if (span.end < first || span.start > last) {
      continue;
    }
    const left = Math.max(0, (span.start - centreMs) / MS_PER_PX + widthPx / 2);
    const right = Math.min(widthPx, (span.end - centreMs) / MS_PER_PX + widthPx / 2);
    marks.push({ key: `${span.start}-${span.end}`, left, width: Math.max(1, right - left) });
  }
  return marks;
}

export const nearestRung = (scrollLeft: number, chipPx: number = CHIP_PX): number => Math.min(LADDER.length - 1, Math.max(0, Math.round(scrollLeft / chipPx)));

export const arrowStep = (key: string): number => (key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0);

/** The rung nearest `multiplier`, so a url-set speed off the ladder still steps sensibly. */
export function rungFor(multiplier: number): number {
  return LADDER.reduce((best, value, at) => (Math.abs(value - multiplier) < Math.abs(LADDER[best]! - multiplier) ? at : best), 0);
}

/** `60×`. */
export const multiplierLabel = (multiplier: number): string => `${multiplier < 0 ? "−" : ""}${Math.abs(multiplier)}×`;

/** `1 min/s`. */
export function rateLabel(multiplier: number): string {
  const abs = Math.abs(multiplier);
  const sign = multiplier < 0 ? "−" : "";
  const trim = (value: number): string => Number(value.toFixed(2)).toString();
  if (abs < 60) {
    return `${sign}${trim(abs)} s/s`;
  }
  if (abs < 3600) {
    return `${sign}${trim(abs / 60)} min/s`;
  }
  if (abs < 86400) {
    return `${sign}${trim(abs / 3600)} h/s`;
  }
  return `${sign}${trim(abs / 86400)} d/s`;
}

export const clockLabel = (date: Date): string => dayjs.utc(date).format("HH:mm:ss");
export const dateLabel = (date: Date): string => dayjs.utc(date).format("ddd DD MMM");
const hhmmLabel = (date: Date): string => dayjs.utc(date).format("HH:mm");
