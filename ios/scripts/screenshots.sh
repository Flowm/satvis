#!/bin/sh
# Takes the App Store screenshots: runs the UI test on a freshly erased
# simulator per App Store size, with a clean status bar, exports the
# screenshots it attaches to ios/screenshots/raw/, shoots the Mac app's window
# there too, and captions them into ios/screenshots/. BASE_URL replaces
# https://satvis.space as the page the views are opened on, which the app
# reaches through scripts/showcase/proxy.mjs for the element sets the moments
# were picked with. Names as arguments (2Sky) retake only those shots, and
# PLATFORM=ios or macos takes one platform's alone.
set -eu
cd "$(dirname "$0")/.."

case "${PLATFORM:-}" in
  "") ios=1 mac=1 ;;
  ios) ios=1 mac= ;;
  macos) ios= mac=1 ;;
  *) echo "PLATFORM is ios or macos, not $PLATFORM" >&2; exit 1 ;;
esac

# The 6.3" iPhone is the size App Store Connect requires; the 6.9" one would
# otherwise be scaled from the 6.5" one, not from it. A line is a simulator's
# name, which names its screenshots, then its device type if another, and an
# iPhone Duo's hinge: App Store Connect takes the Duo closed, on its cover
# display, and open, on its inner one.
runtime="iOS 27.2"
devices="iPhone 18 Pro
iPhone 18 Pro Max
iPhone Duo||closed
iPhone Duo open|iPhone Duo|open
iPad Pro 13-inch (M5)"

# Each screenshot: its test's name, the featured bookmark it opens, whose
# pictureAt in the core config its test stops the clock at, its caption, and
# the seconds the Mac app is given for the tiles, as the test gives the iPhone.
shots="1Globe|Weather satellites|Watch satellites orbit live|20
2Sky|Sky over Lauterbrunnen|Find satellites in your sky|60
3ISS|Follow the ISS|Follow the ISS in orbit|20"

if [ $# -gt 0 ]; then
  shots=$(echo "$shots" | grep -E "^($(echo "$*" | tr ' ' '|'))\|")
fi
if [ $# -eq 0 ] && [ -n "$ios" ] && [ -n "$mac" ]; then
  rm -rf screenshots
fi
for name in $(echo "$shots" | cut -d'|' -f1); do
  for file in "screenshots/"*" - $name.png" "screenshots/raw/"*" - $name.png"; do
    case "$(basename "$file")" in
      "Mac - "*) platform=$mac ;;
      *) platform=$ios ;;
    esac
    if [ -n "$platform" ]; then
      rm -f "$file"
    fi
  done
done
rm -rf build/screenshots-*.xcresult
mkdir -p screenshots/raw

# PROXY_URL in proxy.mjs
site=http://127.0.0.1:5198
node ../scripts/showcase/proxy.mjs "${BASE_URL:-https://satvis.space}" &
trap "kill $!" EXIT
curl -fs --retry 10 --retry-connrefused -o /dev/null "$site/api/groups.json"

udids=
set --
if [ -n "$ios" ]; then
  while IFS='|' read -r device type hinge; do
    # The iPhone Duo takes only its own build of the runtime, which has the same name.
    udid=$(scripts/simulator-udid.sh "$device" "$runtime" 2>/dev/null) ||
      udid=$(xcrun simctl list runtimes | grep "^$runtime (" | sed 's/.* - //' | while read -r id; do
        # A refusal comes on stdout.
        created=$(xcrun simctl create "$device" "${type:-$device}" "$id" 2>&1) && echo "$created" && break
      done)
    [ -n "$udid" ] || { echo "No $runtime runtime takes $device" >&2; exit 1; }
    xcrun simctl shutdown "$udid" 2>/dev/null || true
    xcrun simctl erase "$udid"
    xcrun simctl boot "$udid"
    xcrun simctl bootstatus "$udid" >/dev/null
    if [ -n "$hinge" ]; then
      swift scripts/hinge.swift "$udid" "$hinge"
    fi
    xcrun simctl status_bar "$udid" override --dataNetwork wifi --wifiBars 3 --cellularBars 4 --batteryState charged --batteryLevel 100
    udids="$udids $udid"
    set -- "$@" -destination "id=$udid"
  done <<EOF
$devices
EOF

  xcodebuild build-for-testing -project satvis.xcodeproj -scheme satvis "$@"
fi

# The Mac app as make run-mac builds it: unsigned, so outside the sandbox, with
# its files and settings in the user's own Library.
mac_app=$(pwd)/build/DerivedData/Build/Products/Debug/Satvis.app
if [ -n "$mac" ]; then
  xcodebuild build -project satvis.xcodeproj -scheme satvis -derivedDataPath build/DerivedData -destination platform=macOS CODE_SIGNING_ALLOWED=NO
fi

# One shot at a time: the Mac's window, then every simulator at once, under a
# status bar showing its test's time, as the clock deck does. The status bar
# shows the Mac's time zone, so it is given the instant whose local time reads
# that time, and on its own: given with any other override, an iPad shows the
# weekday the date had in 2000 (Wed 4 Oct). Only the screenshot tests: one that
# fails leaves xcodebuild hanging (AGENTS.md).
while IFS='|' read -r name bookmark caption wait; do
  # The bookmark's pictureAt, then its link, which the Mac app opens on.
  read -r time link <<LINE
$(cd .. && node --input-type=module -e '
    import fs from "node:fs";
    import { parse } from "yaml";
    const presets = parse(fs.readFileSync("worker/src/config/satvis.core.yaml", "utf8")).presets;
    const preset = presets.find(({ featured }) => featured?.some(({ name }) => name === process.argv[1]));
    const bookmark = preset.featured.find(({ name }) => name === process.argv[1]);
    const query = Object.entries(bookmark.query ?? {}).map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
    const path = preset.name === "default" ? "/" : `/${preset.name}`;
    console.log(new Date(bookmark.pictureAt).toISOString().slice(0, 19), query ? `${path}?${query}` : path);' "$bookmark")
LINE
  if [ -n "$mac" ]; then
    # With no UI tests to open the bookmark, the Mac app opens its link, with its
    # window at 1280 by 800 points, 2560 by 1600 pixels on a Retina display: an
    # App Store size. The window's frame is given as an argument, which
    # overrides the one it saved and then overwrites it, so that one is put back.
    saved=$(defaults read org.frcy.app.satvis "NSWindow Frame globe" 2>/dev/null) || saved=
    open -n -F "$mac_app" --env SATVIS_API="$site" --env SATVIS_LINK="$link" --env SATVIS_TIME="${time}Z" \
      --args -ApplePersistenceIgnoreState YES "-NSWindow Frame globe" "0 0 1280 800"
    pid=$(pgrep -n -f "$mac_app/Contents/MacOS/Satvis")
    read -r window width height <<LINE
$(swift scripts/window.swift "$pid")
LINE
    shot=
    if [ "${width}x$height" != 1280x800 ]; then
      echo "The Mac app's window is ${width}x$height points, not 1280x800" >&2
    else
      # The globe draws only while its window is visible.
      sleep "$wait"
      # Without its shadow. The terminal needs Screen Recording in System Settings.
      screencapture -o -x -l "$window" "screenshots/raw/Mac - $name.png" && shot=1 ||
        echo "No screenshot of the Mac app; give this terminal Screen Recording in System Settings" >&2
    fi
    # Killed, not quit, so that the app keeps the view it had before.
    kill "$pid"
    if [ -n "$saved" ]; then
      defaults write org.frcy.app.satvis "NSWindow Frame globe" "$saved"
    else
      defaults delete org.frcy.app.satvis "NSWindow Frame globe" 2>/dev/null || true
    fi
    [ -n "$shot" ] || exit 1
  fi
  if [ -n "$ios" ]; then
    instant=$(date -u -r "$(date -j -f %Y-%m-%dT%H:%M:%S "$time" +%s)" +%Y-%m-%dT%H:%M:%S.000Z)
    for udid in $udids; do
      xcrun simctl status_bar "$udid" override --time "$instant"
    done
    result=build/screenshots-$name.xcresult
    TEST_RUNNER_SCREENSHOTS=1 TEST_RUNNER_BASE_URL="$site" TEST_RUNNER_TIME="$time" xcodebuild test-without-building -project satvis.xcodeproj -scheme satvis \
      -resultBundlePath "$result" -only-testing:"satvisUITests/SatvisUITests/testScreenshot$name" "$@"

    # Named "<device> - <name>.png"
    xcrun xcresulttool export attachments --path "$result" --output-path screenshots/export
    manifest=screenshots/export/manifest.json
    t=0
    while plutil -extract "$t" raw "$manifest" >/dev/null 2>&1; do
      a=0
      while device=$(plutil -extract "$t.attachments.$a.deviceName" raw "$manifest" 2>/dev/null); do
        mv "screenshots/export/$(plutil -extract "$t.attachments.$a.exportedFileName" raw "$manifest")" "screenshots/raw/$device - $name.png"
        a=$((a + 1))
      done
      t=$((t + 1))
    done
    rm -r screenshots/export
  fi

  swift scripts/caption.swift screenshots/raw screenshots "$name" "$caption"
done <<EOF
$shots
EOF
