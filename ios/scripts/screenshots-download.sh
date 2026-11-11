#!/bin/sh
# Downloads the App Store screenshots of the versions being prepared, else of the
# live ones, or of the version VERSION names (e.g. 1.1), in the app's primary
# language, to ios/screenshots/app-store/, under the names they were uploaded with.
# PLATFORM=ios or macos downloads that platform's alone.
set -eu
cd "$(dirname "$0")/.."
. scripts/asc.sh

app=$(asc apps view --id "$ASC_APP_ID" --output json)
locale=$(value "$app" data.attributes.primaryLocale)
download=build/screenshots-download
rm -rf $download screenshots/app-store
mkdir -p screenshots/app-store
for platform in $platforms; do
  name=$(folder $platform)
  if [ -n "${VERSION:-}" ]; then
    versions=$(asc versions list --platform $platform --version "$VERSION" --output json)
  else
    versions=$(asc versions list --platform $platform --state $editable --output json)
    if [ -z "$(value "$versions" data.0.id)" ]; then
      versions=$(asc versions list --platform $platform --state READY_FOR_DISTRIBUTION --output json)
    fi
  fi
  version=$(value "$versions" data.0.id)
  # A version on one platform alone, as 2.1 is on iOS, is no failure.
  if [ -z "$version" ]; then
    echo "No $name version ${VERSION:-being prepared or live}" >&2
    continue
  fi
  string=$(value "$versions" data.0.attributes.versionString)
  localizations=$(asc localizations list --version "$version" --locale "$locale" --output json)
  localization=$(value "$localizations" data.0.id)
  [ -n "$localization" ] || fail "The $name version $string has no $locale text"

  # asc writes <display type>/<position>_<screenshot id>_<file name>.
  asc screenshots download --version-localization "$localization" --output-dir $download >/dev/null
  if ! ls $download/*/* >/dev/null 2>&1; then
    echo "The $name version $string has no $locale screenshots" >&2
    continue
  fi
  for file in $download/*/*; do
    file_name=$(basename "$file")
    mv "$file" "screenshots/app-store/${file_name#*_*_}"
  done
  rm -r $download
done
ls -1 screenshots/app-store
