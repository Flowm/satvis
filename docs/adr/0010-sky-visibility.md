---
status: accepted
---

# Visibility in the sky view is geometry, decided per frame

The sky view shows every active satellite above the observer, but most of them cannot
be seen: in daylight none can, and at night most low satellites are in Earth's
shadow. Which ones "might actually be visible" is mostly geometry the app already
has, and needs no catalogue.

## Decision

**A satellite is visible when it is lit by the sun, the observer's sky is dark, and
it is near enough.** The verdict has four values (`src/modules/util/visibility.ts`):
visible, daylight, too far, and in Earth's shadow, in that order of precedence: a
bright sky hides a satellite whatever else holds, and a far one stays unseen in
sunlight. There is no elevation threshold: the horizon and the terrain already hide
what is below them, in the picture and for the crosshair.

**Earth's shadow is a cylinder of the mean radius along the sun line.** A cone with
a penumbra moves shadow entry in LEO by a few seconds, which no one can see at sky
view scale.

**Beyond 5,000 km a satellite is too far to see.** Without it every GEO satellite is
visible all night outside its eclipse seasons, at magnitude 10-15. Five magnitudes
per tenfold range take a bright satellite, magnitude 3 at 1,000 km, past the
naked-eye limit of about 6 at 4,000 km. The rule is on range, not orbit class: an HEO
satellite near perigee can be seen, near apogee it cannot. Like the twilight cut-off
below, it stands in for a predicted magnitude.

**The sky is dark below a sun elevation of -6°**, the end of civil twilight. This is
a stand-in. Whether a satellite can be seen depends on its brightness against the
sky's, and the sky's depends on the twilight, the moon and light pollution. The
cut-off lives in `visibility()` alone, so a faintest-visible-magnitude model can
replace it without touching its callers.

**Computed in the browser, every frame, never stored.** A verdict holds for one
instant and one observer, and the clock can be scrubbed. The sun is computed once
per frame; the shadow test is a few multiplications per satellite on the position
`skyTargets` already reads. The worker, KV and the metadata bag are untouched.

**One Cesium-free sun.** The Astronomical Almanac's low-precision formula (about
0.01°), rotated by the same GMST as the samples (`temeToFixed.ts`), so the sun and
the satellites share a frame. Cesium's `Simon1994PlanetaryPositions` would only run
on the main thread, and visible passes will need the sun in the pass worker. It is
the formula of `Sun.swift`, so the native app can port it line for line.

**Satellites that cannot be seen are dimmed by default.** Dimmed, they stay in the
sky to lock onto, and the card says why they are dim. On a dark sky they drop to 30%
opacity, to stand apart from the visible ones (at 50%, a dimmed orange GEO point was
as bright as a visible grey one). In daylight they drop to 60%: daylight dims every
satellite alike, so nothing needs to stand apart, and 22% vanished against the blue.
A daylight sky emptied by default would look broken. `?unseen=hide` hides them
instead, and the crosshair skips them; `?unseen=show` draws them like the rest.
Only the point, the label and the 3D model change; orbits and tracks do not.

**The appearance is the satellite's, written only when it changes.** The sky view
writes each satellite's `skyAppearance` every frame, and the satellite restyles its
components only when the value differs, which happens at sunset and at shadow
entry. A `CallbackProperty` per point and label would run for thousands of entities
every frame to return the same colour. Held on the satellite rather than the
component, it survives a component being recreated. Leaving the sky view restores
every satellite it styled.

## Consequences

- **Not brightness.** A dark-coated Starlink in sunlight is "visible" here, and is
  usually too faint for the naked eye, and a GEO satellite's rare glint is "too
  far". Brightness needs a standard magnitude per satellite, which no open
  catalogue has for the megaconstellations: measured values exist per satellite
  type (Mallama et al.), and IAU CPS SCORE holds raw observations to calibrate an
  estimate from GCAT's sizes.
- **Visible passes** can import the same module in the pass worker: a pass's visible
  window is where it is lit in a dark sky, with the shadow boundary found by
  bisection.
- **The native app** does not dim yet. Its `Sun.swift` is the same formula.
