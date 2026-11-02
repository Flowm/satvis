#!/bin/sh
# Takes the App Store screenshots: runs the UI test on a freshly erased
# simulator per App Store size, with a clean status bar, exports the
# screenshots it attaches to ios/screenshots/raw/, and captions them into
# ios/screenshots/. BASE_URL replaces https://satvis.space as the page the
# views are opened on, which the app reaches through scripts/showcase/proxy.mjs
# for the element sets the moments were picked with. Names as arguments (2Sky)
# retake only those shots.
set -eu
cd "$(dirname "$0")/.."

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
# pictureAt in the core config its test stops the clock at, and its caption.
shots="1Globe|Weather satellites|Watch satellites orbit live
2Sky|Sky over Lauterbrunnen|Find satellites in your sky
3ISS|Follow the ISS|Follow the ISS in orbit"

if [ $# -gt 0 ]; then
  shots=$(echo "$shots" | grep -E "^($(echo "$*" | tr ' ' '|'))\|")
  for name in $(echo "$shots" | cut -d'|' -f1); do
    rm -f "screenshots/"*" - $name.png" "screenshots/raw/"*" - $name.png"
  done
else
  rm -rf screenshots
fi
rm -rf build/screenshots-*.xcresult
mkdir -p screenshots/raw

# PROXY_URL in proxy.mjs
site=http://127.0.0.1:5198
node ../scripts/showcase/proxy.mjs "${BASE_URL:-https://satvis.space}" &
trap "kill $!" EXIT
curl -fs --retry 10 --retry-connrefused -o /dev/null "$site/api/groups.json"

udids=
set --
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

# One shot at a time, on every device at once, under a status bar showing its
# test's time, as the clock deck does. The status bar shows the Mac's time
# zone, so it is given the instant whose local time reads that time, and on
# its own: given with any other override, an iPad shows the weekday the date had
# in 2000 (Wed 4 Oct). Only the screenshot tests: one that fails leaves
# xcodebuild hanging (AGENTS.md).
while IFS='|' read -r name bookmark caption; do
  time=$(cd .. && node --input-type=module -e '
    import fs from "node:fs";
    import { parse } from "yaml";
    const presets = parse(fs.readFileSync("worker/src/config/satvis.core.yaml", "utf8")).presets;
    const bookmark = presets.flatMap((preset) => preset.featured ?? []).find(({ name }) => name === process.argv[1]);
    console.log(new Date(bookmark.pictureAt).toISOString().slice(0, 19));' "$bookmark")
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

  swift scripts/caption.swift screenshots/raw screenshots "$name" "$caption"
done <<EOF
$shots
EOF
