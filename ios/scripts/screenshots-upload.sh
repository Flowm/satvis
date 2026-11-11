#!/bin/sh
# Replaces the App Store screenshots of the versions being prepared with
# ios/screenshots/*.png through asc, in the app's primary language: one set per
# display type, holding the files of its size in the order of their names.
# PLATFORM=ios or macos replaces that platform's alone; DRY_RUN=1 says what
# would be replaced and changes nothing.
set -eu
cd "$(dirname "$0")/.."
. scripts/asc.sh

# Each display type's platform, and the portrait widths App Store Connect takes
# for it: the 6.3" iPhone (the required size), the 6.9" one, the iPhone Duo
# (closed and open, in one set) and the 13" iPad, then the Mac, whose landscape
# pictures are as tall as these are wide.
types="IOS:IPHONE_61:1179,1206 IOS:IPHONE_67:1260,1290,1320 IOS:IPHONE_DUO:1398,2007 IOS:IPAD_PRO_3GEN_129:2048,2064
MAC_OS:DESKTOP:800,900,1600,1800"

ls screenshots/*.png >/dev/null 2>&1 || fail "No screenshots in ios/screenshots; run make screenshots"
# asc leaves out a file of no App Store size without a word, and stops at a
# display type with no files after replacing the ones before it.
counts=
for file in screenshots/*.png; do
  width=$(sips -g pixelWidth -g pixelHeight "$file" | awk '/pixel/ { print $2 }' | sort -n | head -1)
  type=$(echo $types | tr ' ' '\n' | grep -E ":([0-9,]*,)?$width(,|$)" | cut -d: -f1,2)
  [ -n "$type" ] || fail "$file is $width pixels across, no App Store size"
  counts="$counts $type"
done
for entry in $types; do
  platform=${entry%%:*}
  type=${entry#*:}
  type=${type%%:*}
  case " $platforms " in *" $platform "*) ;; *) continue ;; esac
  case "$counts " in *" $platform:$type "*) ;; *) fail "No screenshots in ios/screenshots for $type" ;; esac
done

app=$(asc apps view --id "$ASC_APP_ID" --output json)
locale=$(value "$app" data.attributes.primaryLocale)

# Given a folder of locale folders, asc picks each display type's files by their
# size, but it searches them recursively, and screenshots/raw/ has the same sizes.
staged=build/screenshots-upload
rm -rf $staged
mkdir -p "$staged/$locale"
ln screenshots/*.png "$staged/$locale/"

for platform in $platforms; do
  versions=$(asc versions list --platform $platform --state $editable --output json)
  version=$(value "$versions" data.0.id)
  [ -n "$version" ] || fail "No $(folder $platform) version whose screenshots can be edited"
  for entry in $types; do
    [ "${entry%%:*}" = $platform ] || continue
    type=${entry#*:}
    asc screenshots upload --version-id "$version" --path $staged --device-type "${type%%:*}" \
      --replace $(if [ -n "${DRY_RUN:-}" ]; then echo --dry-run; else echo --confirm; fi) --output table
  done
done
