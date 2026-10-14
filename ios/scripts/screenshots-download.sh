#!/bin/sh
# Downloads the App Store screenshots of the version being prepared, else of the
# live one, or of the version VERSION names (e.g. 1.1), in the app's primary
# language, to ios/screenshots/app-store/, under the names they were uploaded with.
set -eu
cd "$(dirname "$0")/.."
. scripts/asc.sh

if [ -n "${VERSION:-}" ]; then
  versions=$(asc versions list --platform IOS --version "$VERSION" --output json)
else
  versions=$(asc versions list --platform IOS --state $editable --output json)
  if [ -z "$(value "$versions" data.0.id)" ]; then
    versions=$(asc versions list --platform IOS --state READY_FOR_DISTRIBUTION --output json)
  fi
fi
version=$(value "$versions" data.0.id)
[ -n "$version" ] || fail "No iOS version ${VERSION:-being prepared or live}"
app=$(asc apps view --id "$ASC_APP_ID" --output json)
locale=$(value "$app" data.attributes.primaryLocale)
localizations=$(asc localizations list --version "$version" --locale "$locale" --output json)
localization=$(value "$localizations" data.0.id)
[ -n "$localization" ] || fail "Version $(value "$versions" data.0.attributes.versionString) has no $locale text"

# asc writes <display type>/<position>_<screenshot id>_<file name>.
download=build/screenshots-download
rm -rf $download screenshots/app-store
asc screenshots download --version-localization "$localization" --output-dir $download >/dev/null
ls $download/*/* >/dev/null 2>&1 || fail "Version $(value "$versions" data.0.attributes.versionString) has no $locale screenshots"
mkdir -p screenshots/app-store
for file in $download/*/*; do
  name=$(basename "$file")
  mv "$file" "screenshots/app-store/${name#*_*_}"
done
rm -r $download
ls -1 screenshots/app-store
