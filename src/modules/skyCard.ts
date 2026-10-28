// What the sky view's lock card says of a satellite (SkyHud.vue), held to the native
// app's (SkyCard.swift) by the parity fixtures.

import { compassPoint, normalizeAzimuth } from "./skyGeometry";
import type { Visibility } from "./util/visibility";

/** The verdict as the card's chip says it. */
export const VISIBILITY_LABEL: Record<Visibility, string> = {
  visible: "Could be seen",
  shadow: "In shadow",
  daylight: "Daylight",
  far: "Too far",
};

/**
 * Whole numbers grouped as en-US, whatever the locale: the app's words are English, and
 * so are the info panel's numbers the card leads to. A tenth of a degree is finer than
 * a phone's compass and flickers as a satellite crosses the crosshair. `|| 0`, as a
 * satellite just under the horizon would otherwise read "-0° up", where Swift prints 0.
 */
const whole = (value: number): string => (Math.round(value) || 0).toLocaleString("en-US");

/** Where to look, for the eye and for a screen reader. */
export function lockPosition(azimuth: number, elevation: number, rangeKm: number): { text: string; spoken: string } {
  const bearing = `${normalizeAzimuth(Math.round(azimuth))}° ${compassPoint(azimuth)}`;
  const range = `${whole(rangeKm)} km away`;
  return {
    text: `${bearing} · ${whole(elevation)}° up · ${range}`,
    spoken: `Azimuth ${bearing}, elevation ${whole(elevation)}°, ${range}`,
  };
}
