#!/bin/sh
# Takes the App Store screenshots: runs the UI test on a freshly erased
# simulator per App Store size, with a clean status bar, exports the
# screenshots it attaches to ios/screenshots/raw/, and captions them into
# ios/screenshots/. BASE_URL replaces https://satvis.space as the page the
# views are opened on.
set -eu
cd "$(dirname "$0")/.."

# The 6.3" iPhone is the size App Store Connect requires; the 6.9" one would
# otherwise be scaled from the 6.5" one, not from it.
runtime="iOS 27"
devices="iPhone 18 Pro
iPhone 18 Pro Max
iPad Pro 13-inch (M5)"

out=screenshots
raw=$out/raw
result=build/screenshots.xcresult
rm -rf "$out" "$result"
mkdir -p "$raw"

set --
while read -r device; do
  udid=$(scripts/simulator-udid.sh "$device" "$runtime" 2>/dev/null) ||
    udid=$(xcrun simctl create "$device" "$device" "$(echo "$runtime" | tr -d ' ')")
  xcrun simctl shutdown "$udid" 2>/dev/null || true
  xcrun simctl erase "$udid"
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" >/dev/null
  xcrun simctl status_bar "$udid" override --time 9:41 --dataNetwork wifi --wifiBars 3 --cellularBars 4 --batteryState charged --batteryLevel 100
  set -- "$@" -destination "id=$udid"
done <<EOF
$devices
EOF

# The screenshot tests alone: the others add nothing to the set, and one that
# fails leaves xcodebuild hanging (AGENTS.md).
tests=satvisUITests/SatvisUITests
TEST_RUNNER_SCREENSHOTS=1 TEST_RUNNER_BASE_URL="${BASE_URL:-https://satvis.space}" xcodebuild test -project satvis.xcodeproj -scheme satvis -resultBundlePath "$result" \
  -only-testing:"$tests/testScreenshot1Globe" -only-testing:"$tests/testScreenshot2Sky" -only-testing:"$tests/testScreenshot3ISS" "$@"

xcrun xcresulttool export attachments --path "$result" --output-path "$raw"

# Name each file "<device> - <attachment name>.png"
manifest="$raw/manifest.json"
t=0
while plutil -extract "$t" raw "$manifest" >/dev/null 2>&1; do
  a=0
  while device=$(plutil -extract "$t.attachments.$a.deviceName" raw "$manifest" 2>/dev/null); do
    file=$(plutil -extract "$t.attachments.$a.exportedFileName" raw "$manifest")
    name=$(plutil -extract "$t.attachments.$a.suggestedHumanReadableName" raw "$manifest" | sed -E 's/_[0-9]+_[0-9A-F-]+\.png$//')
    mv "$raw/$file" "$raw/$device - $name.png"
    a=$((a + 1))
  done
  t=$((t + 1))
done
rm "$manifest"

swift scripts/caption.swift "$raw" "$out" \
  1Globe "Watch satellites orbit live" \
  2Sky "Find satellites in your sky" \
  3ISS "Follow the ISS in orbit"
