#!/bin/sh
# Updates the App Store listing's text from ios/metadata/: the app info, and the
# version the one folder in metadata/version/ names. A field a file leaves out is
# left as it is. DRY_RUN=1 says what it would change.
set -eu
cd "$(dirname "$0")/.."
. scripts/asc.sh

versions=$(ls metadata/version 2>/dev/null) || fail "No ios/metadata/version/; run make metadata-download"
[ -n "$versions" ] && [ "$(echo "$versions" | wc -l)" -eq 1 ] || fail "ios/metadata/version/ holds $(echo $versions), not one version"
asc metadata validate --dir metadata --output table
asc metadata push --platform IOS --version "$versions" --dir metadata ${DRY_RUN:+--dry-run} --output table
