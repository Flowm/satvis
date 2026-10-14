#!/bin/sh
# Replaces ios/metadata/ with the App Store listing's text, one JSON file per
# language: the app's name, subtitle and privacy policy (app-info/), and the
# description, keywords, URLs and release notes (version/<version>/) of the
# version being prepared, else of the live one, or of the version VERSION names.
set -eu
cd "$(dirname "$0")/.."
. scripts/asc.sh

download=build/metadata-download
rm -rf $download
asc metadata pull --platform IOS ${VERSION:+--version "$VERSION"} --dir $download >/dev/null
# asc writes each file on one line; indented, a changed field is a changed line.
find $download -name '*.json' | while read -r file; do
  jq . "$file" >"$file.indented"
  mv "$file.indented" "$file"
done
rm -rf metadata
mv $download metadata
find metadata -name '*.json' | sort
