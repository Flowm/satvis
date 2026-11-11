#!/bin/sh
# Replaces ios/metadata/ with the App Store listing's text, one JSON file per
# language: the app's name, subtitle and privacy policy (app-info/), which every
# platform shares, and per platform the description, keywords, URLs and release
# notes (ios/<version>/, macos/<version>/) of the version being prepared, else of
# the live one, or of the version VERSION names. PLATFORM=ios or macos replaces
# that platform's text alone.
set -eu
cd "$(dirname "$0")/.."
. scripts/asc.sh

download=build/metadata-download
rm -rf $download
for platform in $platforms; do
  name=$(folder $platform)
  # A version on one platform alone, as 2.1 is on iOS, is no failure.
  if [ -n "${VERSION:-}" ] && [ -z "$(value "$(asc versions list --platform $platform --version "$VERSION" --output json)" data.0.id)" ]; then
    echo "No $name version $VERSION" >&2
    continue
  fi
  asc metadata pull --platform $platform ${VERSION:+--version "$VERSION"} --dir $download/$name >/dev/null
done
ls -d $download/*/app-info >/dev/null 2>&1 || fail "No version ${VERSION:-} to download"
# asc writes each file on one line; indented, a changed field is a changed line.
find $download -name '*.json' | while read -r file; do
  jq . "$file" >"$file.indented"
  mv "$file.indented" "$file"
done

[ -n "${PLATFORM:-}" ] || rm -rf metadata
mkdir -p metadata
for pulled in $download/*; do
  name=$(basename "$pulled")
  rm -rf metadata/app-info "metadata/$name"
  mv "$pulled/app-info" metadata/app-info
  mv "$pulled/version" "metadata/$name"
done
rm -r $download
find metadata -name '*.json' | sort
