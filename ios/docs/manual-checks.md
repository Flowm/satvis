# Native app: manual checks

What the native app's tests cannot hold, by area. Rerun the checks a change
touches and put what each returned in the commit message. The record of the
runs up to 2026-11-15 is `manual-verification.md` in git history
(`git show 780efb01:ios/docs/manual-verification.md`).

## How

- The simulator by default (iPhone 18 Pro, an iPad beside it for layout),
  `SATVIS_TIME` pinned for repeatable light, `SATVIS_LINK` for the view,
  `SATVIS_TEST_CATALOG=1` for the UI tests' fixed catalog. `simctl launch`
  passes them with a `SIMCTL_CHILD_` prefix, to `make run` too:
  `SIMCTL_CHILD_SATVIS_TIME=… SIMCTL_CHILD_SATVIS_LINK='/?…' xcrun simctl launch
  --terminate-running-process booted org.frcy.app.satvis`.
- Drawing that should not change: shoot each view with the base commit and the
  branch 45 s after launch at the same `SATVIS_TIME`, and compare pixel by pixel
  below the status bar, the top 180 px on an iPhone 18 Pro, where the clock
  differs: `magick compare -metric AE` on both crops gives 0.
- Motion (flights, menus, the launch): `simctl io <udid> recordVideo`, read a
  frame every 0.1 s (`ffmpeg -i <movie> -vf fps=10 f%03d.png`, Homebrew's).
- Taps sent into the simulator are sometimes dropped: shoot after each one.
- Timing only on an idle Mac: check `sysctl vm.loadavg` first. Under load the
  launch screen alone held 5 s.
- Cost: the iPad mini (`iPdm6`, `iPad14,1`), held with
  `~/.cache/satvis-ipdm6/ipad-lock.sh acquire <you> "<why>"` and released
  after. Build and install a signed Release build:
  `xcodebuild -project satvis.xcodeproj -scheme satvis -configuration Release
  -derivedDataPath build/DeviceData -destination id=<udid>
  -allowProvisioningUpdates build`, then `xcrun devicectl device install app`.
  Alternate old and new builds. The simulator's figures are relative only.
- The benchmark: `xcrun devicectl device process launch --console
  --terminate-existing --device <udid> --environment-variables
  '{"SATVIS_BENCHMARK":"print"}' org.frcy.app.satvis` in the background. The
  report is multi-line JSON; the app stays open after it, so stop it once the
  closing `}` is out (a whole run took under 2 min).
- Pacing, with the panel closed: open the view with `SATVIS_LINK`, wait 25 s,
  run `xcrun devicectl device info processes --device <udid>` (without it
  `xctrace` times out "waiting for device to boot"), then
  `xcrun xctrace record --template 'Animation Hitches' --device <udid>
  --all-processes --time-limit 15s`; the rows of its `displayed-surfaces-interval`
  table over 15 s are the frame rate.

## The globe

- **Unchanged drawing.** `?scene=2D&elements=Point,Label,Orbit,Orbit+track`;
  `?tags=Weather&elements=Point,Label` zoomed so labels cross the limb (each
  vanishes with its point, none flickers); `?tags=Weather&elements=Point,Ground+track,Sensor+cone`;
  the ISS close up, `?tags=&sats=ISS+(ZARYA)&track=ISS+(ZARYA)&elements=Point,Label,Orbit,3D+model&layers=VersaTiles`;
  the sky, `?scene=Sky&gs=46.5935,7.9091,Lauterbrunnen&terrain=ReEarth&layers=VersaTiles`.
- **Terrain.** `?gs=47.4211,10.9853,Zugspitze&layers=VersaTiles&terrain=ReEarth`
  at `SATVIS_TIME=2026-10-04T09:30:00Z`; tap the pin, then the camera button in
  its panel to follow it, and pinch in above the panel (closing the panel ends
  the follow). Two pinches in: relief lit from the sun, no cracks at tile edges,
  no black band along the bottom, no collapse to a coarse tile. At the limit:
  rock from 2 m above it, never black or seen from below. In
  `log show --predicate 'process == "satvis"'`, no 429 from Re:Earth. On
  Natural Earth the Lauterbrunnen cliffs still stand.
- **The limb.** The default view at 12:00 and 17:30 UTC: the limb and the
  atmosphere's ring smooth, no facets.
- **Lines.** Weather with orbits at a 3× crop: one point wide, edges faded over a
  device pixel. The ISS's orbit at 12:25 UTC closes with no step at the seam.
- **Close up.** `?tags=&sats=SENTINEL-2A&track=SENTINEL-2A` with Point, Label,
  Orbit, Orbit track and Sensor cone, pinched to about 80 m: both lines run
  through the point, which holds its pixel frame to frame.
- **3D models.** The ISS link from the about page: the model lit, the camera
  opening six radii off once it loads, point and label hidden.
- **Labels.** Near the limb, against satvis.space at 390 × 844.
- **Instrument imagery.** `imagery=` links for METEOSAT-12, TERRA and GOES 19.
  METEOSAT-12's GeoColour over Black Marble pinched in three times and out: no
  base map showing through on the way out, no tiles asked for levels passed.
  8 h back at 600×, the frames follow the clock. Switched off after a zoom, the
  base map alone remains.
- **Geostationary Ring.** `SATVIS_TIME` half an hour after a listed Slot, Map →
  GEO satellites → Geostationary Ring, Day/Night: north up, the base map only
  poleward; another Slot's half hour moves day and night.

## Touch, flights and panels

- **Gestures.** A clockwise twist turns north to the right; a tap on the end of a
  name picks its satellite; a finger held on the globe or a pin opens the globe
  menu at the finger, a drag after the hold does not turn the globe, later taps
  still land, and nothing opens in the sky view.
- **Flights.** Track flies into tracking and the globe button straight home; the
  Lauterbrunnen demo flies into the sky view with no frame jumping and the map
  turning, not rolling.
- **The sky view.** The about page's sky link,
  `?scene=Sky&gs=46.5935,7.9091,Lauterbrunnen&terrain=ReEarth&layers=VersaTiles&stars=DeepStar2K&tags=Active`,
  at 2026-10-04T19:22:00Z: with no drag, the crosshair takes METEOSAT-11
  (MSG-4), its card reading "178° S · 33° up". The card has four lines on a
  phone, seven on an iPad. Munich at 2026-10-05T17:45:00Z dims what is
  in the Earth's shadow.
- **Menu column and panels**, on a phone and an iPad: the burger and the cross
  swap in one frame; each panel opens beside the column, Satellites too on an
  iPad; the Graphics panel shows whole at the XXL text size.
- **Info panel tabs.** GOES 19 on the test catalog and the live ISS: the
  Instruments table without full names on a phone and with them aligned on an
  iPad; TERRA's MODIS button opens Imagery at its card; the tab row scrolls.
- **Map panel imagery.** GEO and LEO groups closed, counts, names fitting; one
  group open at a time; a switched-on layer reads "1 on".
- **Bookmarks.** Recent pictured from the frame, demos with the site's pictures,
  Save, a card's "…" for Rename, Delete and Share; pictures still there on a
  launch with no network.
- **About and credits.** The credits follow the map; with terrain on,
  "© OpenStreetMap" stands left of the clock deck for five seconds.
- **Look up.** The simulator's location at Innsbruck: Look up stands there, and
  Locations lists Geolocation first.
- **Launch.** A never-used simulator, launched twice and the second recorded
  (the first, on 2026-11-15, drew nothing behind the shuttle for 5 s): the
  launch screen, the smoke and the shuttle, the globe coming up under the smoke;
  with Reduce Motion, nothing moves.
- **iPhone Duo.** `make fold` and `make unfold` under the running app: closed,
  the column folds; open, it opens as on an iPad. The UI tests on both.
- **The Mac.** `make run-mac`: drag, scroll, pinch and twist; clicks, double and
  triple; right-, Control- and force-click for the globe menu; the arrows, + and
  -, space and Escape without clicking first; the globe under the title bar,
  which still drags the window; the View, Satellite, Bookmarks and Help menus,
  Copy Link (⇧⌘C) and Bookmarks (⌘B) as a panel; no compass or camera in the sky
  view; GPU use falls to nothing when the window is covered; the window, its
  size and tracking restored after quitting; closing it quits.

## Cost, on the iPad mini

- **The benchmark** before and after any change to drawing or per-frame work.
- **Pacing** with the panel closed: the ISS tracked, Weather idle, the default
  view idle (`/`, about 3.3 fps), all active orbits
  (`/?tags=Active&elements=Point,Orbit`).
- **120 fps** on a ProMotion iPhone: `devicectl device process launch --console
  -- org.frcy.app.satvis -frameRate '<integer>120</integer>'` with the benchmark.
- **Passes** for a station picked on `tags=Active&elements=Point`: the first
  within seconds, listed as they come.

## Never checked

Open until someone checks them; remove a line once one has.

- The compass: aiming, its drag hand-back and levelling, on a device.
- Whether a device loses the touches right after the location prompt, as the
  iOS 27 simulator does (`testLooksUpFromWhereTheDeviceIs` retries).
- All active orbits locking to a divisor of the display rate with the
  performance panel closed, on the base and the branch alike: not explained.
- The Mac checks above: an agent's shell cannot drive the Mac app.
- The globe menu on a device: its haptic, a pointer's click-and-hold on an iPad,
  and a second touch within 0.3 s after a 0.6 s hold.
- The launch on a device, an upgrade over the old launch screen, and a touch in
  the first second, which reaches the globe under the black.
- A Plus or Pro Max iPhone in landscape, which gets the iPad's sky card.
- The iPhone Duo half open, and Split View.
- The terrain credit on a cold launch over a slow network.
- The bookmark name alert's Save tapped after typing.
- The Earth turning under the inertial camera, by eye.
