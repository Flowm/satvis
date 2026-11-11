#!/bin/sh
# Updates the App Store listing's text from ios/metadata/: the app info, and per
# platform the version the one folder in metadata/ios/ or metadata/macos/ names.
# A field a file leaves out is left as it is. PLATFORM=ios or macos updates that
# platform's version alone; DRY_RUN=1 says what it would change.
set -eu
cd "$(dirname "$0")/.."
. scripts/asc.sh

staged=build/metadata-upload
first=${platforms%% *}
for platform in $platforms; do
  name=$(folder $platform)
  versions=$(ls "metadata/$name" 2>/dev/null) || fail "No ios/metadata/$name/; run make metadata-download"
  [ -n "$versions" ] && [ "$(echo "$versions" | wc -l)" -eq 1 ] || fail "ios/metadata/$name/ holds $(echo $versions), not one version"

  # In asc's layout. The app info is the app's, not a platform's: it goes once.
  rm -rf $staged
  mkdir -p $staged/version
  [ "$platform" != "$first" ] || cp -R metadata/app-info $staged/
  cp -R "metadata/$name/$versions" $staged/version/
  echo "$name $versions:"
  asc metadata validate --dir $staged --output table
  asc metadata push --platform $platform --version "$versions" --dir $staged ${DRY_RUN:+--dry-run} --output table
done
rm -rf $staged
