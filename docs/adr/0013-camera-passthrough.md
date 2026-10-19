---
status: accepted
---

# The native sky view shows the camera behind it, aimed by the compass

Held up to the sky, the native app's sky view can show the back camera's picture
behind the satellites, so that what is on screen is the sky the user is looking at
with the satellites named on it. The web app has no camera passthrough.

## Decision

**A preview layer under a transparent globe, not ARKit and not a camera texture.**
`AVCaptureVideoPreviewLayer` fills the window under the Metal view, which turns
non-opaque while the camera shows and draws nothing where the scene leaves the sky
(`SkyPassthrough.swift`). The system composites the picture at the camera's own rate
and latency, and the frames never reach the app.

ARKit's world tracking was the alternative. What the sky view draws is at infinity,
so only the camera's rotation matters, and the translation ARKit tracks with visual
odometry would buy nothing; its `gravityAndHeading` alignment reads the same compass
CoreMotion does, takes the camera over and costs a phone's battery. A Metal texture
from a video data output, drawn as the backdrop, would hop every frame to the main
thread, tone-map the picture with the scene, and put the user's surroundings into the
bookmark pictures, which read the drawable.

**The compass aims it, always.** A camera picture under a sky aimed by hand does not
match it, and looks like a working feature that is wrong, which ADR 0004 refuses.
So switching the camera on starts the compass first, and a compass that cannot start
(no sensor, no heading, a silent sensor) leaves the camera off and says why. Whatever
stops the compass stops the camera, however it stopped: its button, a drag that takes
the aim back, leaving the sky view, a sensor that falls silent. `Session` holds that
rule in one place, by watching the compass. Switching the camera off leaves the
compass aiming.

**A pinch is not a drag.** A drag past the tap's slop takes the aim back (ADR 0004),
but the fingers of a pinch drift as they spread, before a pinch is even recognised.
So the fingers are counted as they touch, and only a drag by one finger alone takes
the aim back; one a second finger has joined never does, until the last lifts.

**Where, not when.** The camera shows where the device is, so a sky drawn for
another place matches the picture only by chance. While the camera shows, the device's
position is compared with the station the sky view stands on, and past 5 km, which
moves a satellite overhead at the ISS's height by under a degree, the sky view says
so for as long as it lasts; it says so too where the position cannot be had. It warns
rather than refuses: the user may know better, as on a station they just placed. A
clock away from now is no such mismatch: the sky to come, or gone, over the place in
the picture is a view the clock is there for.

**The system can take the camera away.** Another app in Split View or Stage Manager,
a call, or the app going to the background interrupts the capture session. Until it
comes back the sky is drawn as without the camera, which keeps showing; after a
runtime error the session is started again once the media services are reset, and
the camera switched off otherwise.

**The field of view is the camera's.** The renderer holds a `CameraLens`: the
tangent of half the picture's long side, from the active format's horizontal field
of view (corrected for distortion where the device corrects it), the picture's
aspect ratio, and whether its long side stands up the screen, which follows the
rotation coordinator's preview angle. The vertical field of view is worked out from
it every frame for the aspect fill of the view's shape, so a turned screen follows at
once. A pinch zooms the camera instead of the field of view, up to 8×, where a
wide-angle camera's 70° reaches the sky view's narrowest, 10°: digital zoom crops
the centre, so it divides the tangent. Switching the camera off keeps the field of
view it had, rather than jumping back, brought into the sky view's own range.

**The ground hides, but is not drawn.** Under the camera the scene clears to
transparent, draws neither the stars nor the atmosphere, and draws the terrain into
the depth buffer alone. Satellites below the horizon or behind a ridge stay hidden,
as ADR 0003's opaque ground keeps them, while the real ground shows. The tonemap
writes premultiplied alpha, and an opaque part of a 3D model writes an alpha of 1
whatever its texture's.

**Not in links.** It needs a permission and a device held up, as the compass does,
which is not in links either; and the web app, whose links these are, has no camera.

## Consequences

- **Only a device shows it.** The simulator has no camera, and the app says so. How
  well the picture registers with the sky depends on the compass and on how the
  camera sits in the device, neither of which a test can check. Lens distortion
  past what the device corrects is not modelled, so the picture's edges can sit a
  degree or so off the satellites drawn over them.
- **A bookmark taken with the camera on** pictures the satellites on black: the
  drawable is clear where the camera shows, which the JPEG reads as black.
- **The camera's usage string** is the app's `NSCameraUsageDescription`. The privacy
  manifest is unchanged: no frame is recorded, read or sent.
