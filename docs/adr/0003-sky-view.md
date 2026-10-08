---
status: accepted
---

# The sky view is a view mode, and it owns the camera

Pointing a phone at the sky to identify what passes overhead is the scene the globe
already draws, seen from another place. So it is not a second renderer, a route or a
separate app. The existing Cesium camera is parked on the ellipsoid at the observer
and aimed up, and the satellites are the entities that were there anyway. Rendering,
metadata, pass prediction, the shared clock and `viewer.selectedEntity` →
`EntityInfoPanel` all come along unchanged.

This ADR answers two questions: where the mode lives, and what happens to the other
things that want to drive the camera.

## Decision

### Sky is a fourth view mode

`SCENE_MODES` (`src/config/viewModes.ts`) is `["3D", "2D", "Columbus", "Sky"]`,
carried in the existing `scene` parameter as `?scene=Sky`.

The alternative was a separate `skyView` store key on a new `view` parameter,
orthogonal to `scene`, on the grounds that "which projection" and "where am I
standing" are different questions. They are, but they are not _independent_: a
ground-level camera in a 2D projection is meaningless, so two parameters would need a
rule forbidding half their combinations. One radio group cannot express an illegal
combination.

Reusing `scene` also wires the mode for free. `SCENE_MODES` feeds the store's
`enumString` and the radio group's `cc.sceneModes`, so the parameter, its validation
and its control are one tuple edit, and `?scene=banana` falls back to the default.

The cost is that `cesiumStore.sceneMode` no longer names a Cesium `SceneMode`: in sky
view the store says `Sky` while `viewer.scene.mode` is `SCENE3D`. That is harmless,
because every `SCENE3D` test in the codebase reads Cesium's enum and none reads the
store string, and it is correct, because the sky view _is_ 3D. `viewModes.ts` is the
app's own view vocabulary, three of whose members match Cesium's.

### The observer is a ground station, designated

The sky view looks up from a point on the ground, and the app already has a name for
that. So `?scene=Sky&gs=48.14,11.58` is a complete, shareable "what is over me now",
and the detail card's next-pass figures are the pass prediction already computed. A
second location concept would have to explain which of the two a countdown belongs
to.

Which station is the observer is a designation beside the list
(`sat.observerStation`, default 0), so entering the sky view from a station's info
panel designates it instead of reordering the list. Three places read the
designation and must agree: entry (`resolveObserver` in `sceneSync.ts`), the watcher
that moves a live view when the station moves, and the walk that writes back. The
designation is not a url parameter: a link carries the stations and the view mode,
and its observer is the first station. A parameter would extend ADR 0001 and is a
separate decision.

Entry is an action gated on an observer existing, not a watcher. With no ground
station, the device's location becomes one, and if that is refused the sky view does
not open. A sky full of satellites at coordinates the user never chose looks like a
working feature, which is worse than not opening.

### Walking moves the ground station, once the keys stop

`WASD` walks the observer across the ground, `E` and `Q` raise and lower the eye, and
shift multiplies the speed. Forward is the aim's azimuth without its pitch: the sky
view mostly looks up, so moving along the view axis would fly into the sky. The
height keys do that.

The observer _is_ a ground station, so a walk must end there: the map pin, the
next-pass figures and `?gs=` all follow one point, and a private camera position
would be the second location concept rejected above. The walked station keeps its
name and its place in the list: a walk is a move, not a reorder. A station move
recomputes every active satellite's passes and pushes a url entry, which cannot
happen sixty times a second. So `SkyView.moveObserver` moves the view every frame,
and `SkyMovement` reports the observer to the store once the keys have been still for
350 ms. One walk is one station move, one recomputation and one history entry.

The ground under a walk is measured on a throttle: every 250 ms, which is 5 m of
walking or 40 m of sprinting, plus one measurement when the keys stop. `enter` can
measure outright because it is one move. A walk cannot afford a request per frame,
and measuring nothing leaves the eye underground as soon as the walk goes uphill.

A walk must **not** fall back to `globe.getHeight`. It is free and follows terrain
per frame, so it is the fallback of last resort before anything has measured. But it
answers about the globe, and under a surface model the globe is not what you stand
on. Under the photorealistic mesh the globe is not drawn, and its ellipsoid answers a
plausible 0 that passes the plausibility guard and puts the eye hundreds of metres
inside the mesh, from a single keypress.

Height above the ground is **not** in the url. The wire format's ground station is a
point that passes are computed against, and passes are the same whether the eye is
at 2 m or 500. A third coordinate would feed the pass predictor a number it has no
use for. The eye height belongs to the view and resets on entry with the aim and the
zoom.

### Inertial is suppressed; tracking is cleared

Three things want to write the camera every frame, and the sky view cannot share it
with any of them.

`cameraMode: "Inertial"` re-parents the camera on every `postUpdate`, so a one-time
`lookAtTransform(Matrix4.IDENTITY)` is undone on the next tick. It is
**suppressed** (`suppressCameraMode`): the listener is detached on entry and
re-attached on exit, and the store and `?camera=Inertial` are untouched. This is the
pattern a scene morph uses for the batched orbit components: the user's choice
stands, and the scene declines to honour it for a while.

Tracking is **cleared**, as an invariant, not an event: while sky is the view mode
nothing is tracked, and any attempt to track is undone. Suppression was the symmetric
option, but tracking has no meaning that survives the trip (the camera cannot follow
a satellite and stand on the ground). Only an invariant covers `?scene=Sky&track=X`
arriving whole at hydration, where there is no entry moment, and
`pendingTrackedSatellite` resolving minutes later when its group loads.

So leaving does not restore the tracked satellite, an exception to "leaving restores
the globe". A sky-native meaning for tracking (an on-sky target with a guidance arc)
is left to the pass-timeline work.

Clear tracking by writing `satStore.trackedSatellite`, never by assigning
`viewer.trackedEntity`. Tracking is the one value the globe reports _back_, so poking
Cesium reaches the store through `#onTrackedChange` and races the forward path.

### Vertical FOV is the contract

Cesium's `PerspectiveFrustum.fov` is the horizontal angle when the viewport is wider
than tall and the vertical angle otherwise. Everything the sky view cares about is
vertical (whether the horizon is on screen at a given pitch, whether the overlay
registers with a camera image), so the vertical angle is stored, and Cesium's `fov`
is derived from the live aspect ratio and recomputed when it changes.

Defaults are `fovy = 75°` and `pitch = 30°` on every device. They guarantee
**`pitch < fovy/2` on entry**, so there are no per-orientation numbers and no pixel
arithmetic to go stale.

That holds for the defaults only, not as an invariant. Wheel and pinch move `fovy`
within 10–100°, and zooming in on something high is _supposed_ to take the horizon
off screen; clamping pitch to keep the inequality would tilt the view down as the
user zoomed. The range is clamped in the `fovy` setter, not per gesture, because it
belongs to the view, not the input.

Zoom changes the field of view and nothing else: no zoom-to-cursor. Recentring would
move the aim, and under device-orientation aiming the sensor overwrites the aim on its
next reading, so it would snap back. Screen centre is the only rule that behaves the
same under a drag and under the sensor.

### Entering and leaving are flights, not cuts

The camera flies between the globe pose and the ground pose over 2.2 s
(`src/modules/skyFlight.ts`).

This carries the claim the mode rests on: it is the same scene from another place. A
cut says otherwise. The globe and a sky full of satellites share too few pixels for
the eye to connect them, so a cut reads as arriving somewhere else.

`camera.flyTo` cannot do it, for the same reason `camera.setView` cannot place the
camera: it routes orientation through heading/pitch/roll and mirrors the sky near the
zenith. So the blend is ours, and the attitude is interpolated as a quaternion. A
lerp of three unit vectors is not orthonormal in between, and Cesium renders whatever
basis it is given.

### The flight has three legs, because two poses are not a journey

Blending only the endpoints is not enough. The attitude reaches sky-like within a few
hundred milliseconds, the globe leaves the frame, and the rest of the descent shows
empty sky while the position travels. So one clock drives three legs:

1. **Lock on** (first 30%). The view swings onto the observer. Early, because this
   leg answers "where is this going", and the position has barely moved, so it reads
   as a pan.
2. **Descend** (to 55%). The observer stays at the exact centre of the screen and
   grows as the camera closes in, ending **directly overhead**, looking down. The
   observer's map pin is already drawn there, so the destination is labelled.
3. **Rise** (last 45%). The camera drops the rest of the way, lands at 80%, and the
   view sweeps up past the horizon to the aim.

Ending overhead before landing is a correctness requirement. A swoop along its own
great-circle tangent reaches the ground travelling sideways, and an aim tracking the
observer then whips through the last few metres (10° in one frame was measured
before the legs were split). Arriving vertically lets the descent's aim reach
straight down smoothly, which is where the rise starts.

So the rise is `skyBasis` at a pitch of −90°, not any convenient nadir. Built from the
same aim, the whole leg is a change of pitch only: no roll creeps in, and the view
arrives facing the way it faced during the descent. `skyBasis` is continuous through
straight down (the zenith tests pin this), so −90° is an aim like any other.

The aim is built by turning the straight-down attitude onto the line of sight, not by
crossing the view axis with an up vector. A cross-product look-at has no answer when
the camera is directly overhead, which is where this flight ends. Turning makes that
case the identity rotation.

Consequences:

- **`active` and `settled` are different.** The view owns the camera for both flights
  (`active`), but the aim describes the screen only after landing (`settled`). The
  HUD tapes and the crosshair read `settled`, and the overlay fades up as the ground
  arrives.
- **Interaction starts on landing.** Dragging and the sensor both write the aim, and
  the aim is the flight's destination, so a gesture during the descent would steer
  it.
- **Leaving is the same flight backwards.** One path, one clock and a sign, so there
  is no second schedule to keep in step. Turning around is free: a switch back
  mid-flight flips the sign and resumes from the progress made.
- **Exit is asynchronous.** `exit()` returns a promise, and morphing the projection or
  releasing the camera mode waits for it, so two quick clicks cannot leave the globe
  half-restored.

With reduced motion requested, the duration is zero and the camera is assigned
outright: the cut, in full, not a faster version of the movement.

## Consequences

- **Restore what you changed, and only that.** `set background(false)` destroys the
  sky box, sun, moon and atmosphere for good, so "restore the sky objects" cannot
  work after `?bg=false`. The sky view is to hide them only when camera passthrough
  is on, since without a camera feed the sky box is the right backdrop. Passthrough
  is not implemented, so today the sky view never touches them.
- **No `scene.pick`.** The crosshair takes the nearest satellite within its capture
  radius from projected screen positions, which the HUD computes for the tapes
  anyway, and assigns it to `viewer.selectedEntity`. The pick rectangle is in
  drawing-buffer pixels and the capture radius in CSS pixels, so a pick-based
  crosshair would change reach by 3× with the quality preset. Occlusion is an
  explicit horizon test plus a terrain ray (`groundHides`), shared with the orbit
  trace. The ray keeps the crosshair in agreement with the picture, which is
  depth-tested against terrain (`SkyView#enter`); without it a satellite behind a
  ridge is hidden but lockable. Candidates are asked nearest first, only until one is
  visible, so a normal frame casts one ray. The viewer's own click and double-click,
  which select and track what is under the pointer, are off while the sky view's
  interaction runs.
- **The capture radius stays in CSS pixels**, so its angular reach follows the zoom:
  ±5.3° at the default on an 844 px-tall phone, ±0.71° at maximum zoom. Zooming in
  _is_ how you choose between two satellites in the reticle, which a radius in
  degrees would prevent.
- **The ground stays opaque.** A translucent globe would show a camera feed through
  the earth, but it would also show the satellites the earth should hide. Correct
  occlusion is worth more than seeing the real ground. Revisit only if passthrough
  makes an opaque lower half untenable.
- **The shared clock works in the sky view on every device**, through the clock deck
  (CONTEXT.md, **Clock deck**). It was desktop-only while `minimalUI` hid Cesium's
  clock widgets on iOS.
- **The overlay's click-through is checked in a real browser**, because the unit
  tests have no layout: `e2e/regressions/skyHud.spec.ts`.
