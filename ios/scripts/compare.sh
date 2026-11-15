#!/bin/sh
# Shoots the views the globe's drawing is judged on with the app built from a
# base commit and from the working tree, on one simulator at pinned instants,
# and compares them pixel by pixel. Usage: compare.sh <udid> [base], base
# defaulting to the merge base with main; the working tree's build must be in
# build/DerivedData (make build). Shots and the differences go to build/compare/;
# it fails if any view differs.
set -eu
cd "$(dirname "$0")/.."

udid=${1:?usage: compare.sh <udid> [base commit]}
base=$(git rev-parse --verify "${2:-$(git merge-base HEAD main)}^{commit}")
wait=${WAIT:-45}
out=build/compare
head_app=build/DerivedData/Build/Products/Debug-iphonesimulator/satvis.app
base_app=$out/base-data/Build/Products/Debug-iphonesimulator/satvis.app
command -v magick >/dev/null || { echo "compare needs ImageMagick: brew install imagemagick" >&2; exit 1; }
[ -d "$head_app" ] || { echo "No build of the working tree: make build" >&2; exit 1; }

# A view is its name, the instant it is shot at and its link. The tiles and the
# catalog come from the network, so base and branch are shot one after the
# other for each view, not in two passes minutes apart.
views="2d|2026-11-15T12:00:00Z|/?scene=2D&elements=Point,Label,Orbit,Orbit+track
labels|2026-11-15T12:00:00Z|/?tags=Weather&elements=Point,Label
cones|2026-11-15T12:00:00Z|/?tags=Weather&elements=Point,Ground+track,Sensor+cone
limb|2026-11-15T17:30:00Z|/
iss_orbit|2026-11-15T12:25:00Z|/?tags=&sats=ISS+(ZARYA)&elements=Point,Orbit
close_up|2026-11-15T12:00:00Z|/?tags=&sats=SENTINEL-2A&track=SENTINEL-2A&elements=Point,Label,Orbit,Orbit+track,Sensor+cone
iss_model|2026-11-15T12:00:00Z|/?tags=&sats=ISS+(ZARYA)&track=ISS+(ZARYA)&elements=Point,Label,Orbit,3D+model&layers=VersaTiles
sky|2026-11-15T12:00:00Z|/?scene=Sky&gs=46.5935,7.9091,Lauterbrunnen&terrain=ReEarth&layers=VersaTiles"

mkdir -p "$out/base" "$out/head" "$out/diff"
tree=$(mktemp -d)
trap 'git worktree remove --force "$tree" 2>/dev/null || true; xcrun simctl status_bar "$udid" clear 2>/dev/null || true' EXIT
git worktree add --quiet --detach "$tree" "$base"
echo "Building $(git log -1 --format='%h %s' "$base")"
xcodebuild -quiet -project "$tree/ios/satvis.xcodeproj" -scheme satvis -derivedDataPath "$out/base-data" \
  -destination "id=$udid" CODE_SIGNING_ALLOWED=NO build

xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
# The status bar's clock would otherwise differ between every two shots.
xcrun simctl status_bar "$udid" override --time 9:41

shoot() { # app, build, view's name, instant, link
  xcrun simctl install "$udid" "$1"
  SIMCTL_CHILD_SATVIS_TIME=$4 SIMCTL_CHILD_SATVIS_LINK=$5 \
    xcrun simctl launch --terminate-running-process "$udid" org.frcy.app.satvis >/dev/null
  sleep "$wait"
  xcrun simctl io "$udid" screenshot "$out/$2/$3.png" >/dev/null 2>&1
}

rm -f "$out/differ"
echo "$views" | while IFS='|' read -r name instant link; do
  shoot "$base_app" base "$name" "$instant" "$link"
  shoot "$head_app" head "$name" "$instant" "$link"
  # magick compare prints the count of differing pixels on stderr, and exits 1 when there are any.
  count=$(magick compare -metric AE "$out/base/$name.png" "$out/head/$name.png" "$out/diff/$name.png" 2>&1 >/dev/null || true)
  count=${count%% *}
  echo "$name: $count pixels differ"
  [ "$count" = 0 ] || echo "$name" >>"$out/differ"
done
xcrun simctl terminate "$udid" org.frcy.app.satvis 2>/dev/null || true

if [ -s "$out/differ" ]; then
  echo "Differ: $(tr '\n' ' ' <"$out/differ")(see $out/diff/)" >&2
  rm -f "$out/differ"
  exit 1
fi
echo "Every view matches $(git rev-parse --short "$base")."
