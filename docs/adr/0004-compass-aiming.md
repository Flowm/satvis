---
status: accepted
---

# Compass aiming needs true north, or it does not happen

The sky view can hand its aim to the device's orientation sensor, which reports a yaw
about the vertical (`alpha`) from an arbitrary zero. A real azimuth needs a heading
reference, and there are two: Safari's `webkitCompassHeading`, and Chrome's
earth-referenced `deviceorientationabsolute`. On a device with neither, compass
aiming **refuses to start** and says why, instead of aiming from a bearing nobody
measured.

## Decision

Where an absolute reading exists it is used directly: `alpha` is already measured
from north, so the correction is zero at any posture. Where only
`webkitCompassHeading` exists, the offset is computed from it, but only while the
screen is near horizontal (`COMPASS_POSTURE_TOLERANCE` in
`src/modules/DeviceAim.ts`). The `360 - heading` substitution holds for a phone lying
flat, and applying it continuously makes the sky spin as the device tilts. So north
is not known the instant the compass is switched on, and the HUD shows a note until
it is.

There is no manual trim. It existed because two conventions were unverified: the
sign of the screen-orientation correction, and whether `webkitCompassHeading` lines up
with `alpha` as the workaround assumes. iOS hardware confirmed both with the trim at
zero, and a trim would only ask the user to guess a bearing.

### A drag takes the aim back

Dragging while the compass aims turns the compass off and then drags. It is not
ignored.

There is no third option. The sensor writes the aim on every reading, so a drag that
only nudged it would be erased within about 60 ms. A gesture that visibly does
nothing reads as a broken compass. Only unsubscribing lets the user have the aim.

The threshold is the tap slop that selection uses (`TAP_SLOP` in
`SkyInteraction.ts`), not the first pixel: a tap chooses a satellite, and the tremor
inside one must not cost the compass. The movement keys are the same trade from the
other side: walking moves the observer and never the aim, so it leaves the compass
on.

Handing back **levels the view**. Only the sensor ever rolls the sky view, so a roll
left behind is one the pointer cannot straighten, and a frozen tilted horizon reads
as a broken view. So `disableDeviceOrientation` levels it whoever asked: the control,
a drag, or the view closing.

A drag during the 1200 ms sensor probe is the awkward case: the aim is being
written, but the outcome is not decided. Reporting "aiming" would leave the control
claiming a compass that is off, so the probe checks whether the aim is still its own
before it answers. That outcome is `taken-back`, the one outcome that shows the user
nothing, because the user ended it.

`enableDeviceOrientation` reports which outcome happened (aiming,
aiming-but-not-yet-calibrated, unsupported, denied, granted-but-silent, no-heading,
or taken-back), not a boolean, because each needs different words: a laptop has no
sensor to grant, a declined permission can be asked again, a device with no
magnetometer will not get one, and a person who took the aim by hand needs no
message.

## Consequences

- **Android is unverified.** The absolute path follows the specification, not tested
  hardware, and `DeviceOrientationEvent` needs a secure context, so `pnpm dev:host`
  cannot exercise it. The refusal keeps that honest: an untested path either gives a
  real heading or declines.
- **A silent sensor is a refusal too.** Desktop browsers define the event and grant
  it, then never fire it, so the sensor gets 1200 ms to prove itself before the aim
  is handed over. Trusting the grant would freeze the view.
- **`absolute` is trusted only from the absolute event.** `deviceorientation` also
  sets the flag, to false, and reading that as a claim about iOS's heading would
  disable the `webkitCompassHeading` path.
- **This is ADR 0003's rule for the observer:** the sky view does not open at a
  fallback location either. A sky full of satellites in the wrong places looks like a
  working feature, which is worse than a control that declines and says why.
