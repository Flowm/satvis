#!/bin/sh
# Takes the App Store screenshots: runs the UI test on a freshly erased
# simulator per App Store size, with a clean status bar, and exports the
# screenshots it attaches to ios/screenshots/.
set -eu
cd "$(dirname "$0")/.."

devices="iPhone 17 Pro Max
iPad Pro 13-inch (M5)"

out=screenshots
result=build/screenshots.xcresult
rm -rf "$out" "$result"

set --
while read -r device; do
  # The newest runtime that has the device is listed last
  udid=$(xcrun simctl list devices available | grep -F "    $device (" | tail -1 | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
  [ -n "$udid" ] || { echo "No simulator named $device" >&2; exit 1; }
  xcrun simctl shutdown "$udid" 2>/dev/null || true
  xcrun simctl erase "$udid"
  xcrun simctl boot "$udid"
  xcrun simctl bootstatus "$udid" >/dev/null
  xcrun simctl status_bar "$udid" override --time 9:41 --dataNetwork wifi --wifiBars 3 --cellularBars 4 --batteryState charged --batteryLevel 100
  set -- "$@" -destination "id=$udid"
done <<EOF
$devices
EOF

TEST_RUNNER_SCREENSHOTS=1 xcodebuild test -project satvis.xcodeproj -scheme satvis -resultBundlePath "$result" "$@"

xcrun xcresulttool export attachments --path "$result" --output-path "$out"

# Name each file "<device> - <attachment name>.png"
manifest="$out/manifest.json"
t=0
while plutil -extract "$t" raw "$manifest" >/dev/null 2>&1; do
  a=0
  while device=$(plutil -extract "$t.attachments.$a.deviceName" raw "$manifest" 2>/dev/null); do
    file=$(plutil -extract "$t.attachments.$a.exportedFileName" raw "$manifest")
    name=$(plutil -extract "$t.attachments.$a.suggestedHumanReadableName" raw "$manifest" | sed -E 's/_[0-9]+_[0-9A-F-]+\.png$//')
    mv "$out/$file" "$out/$device - $name.png"
    a=$((a + 1))
  done
  t=$((t + 1))
done
rm "$manifest"
