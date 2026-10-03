#!/bin/sh
# Prints the UDID of the available simulator named $1 on runtime $2, e.g.
# "iOS 27". Without $2, on the newest runtime that has one: names repeat across
# installed runtimes, and the newest is listed last.
set -eu

udid=$(xcrun simctl list devices available | awk -v name="$1" -v runtime="${2:-}" '
  /^-- / { listed = runtime == "" || index($0, "-- " runtime) == 1; next }
  listed && index($0, "    " name " (") == 1 { line = $0 }
  END { print line }
' | sed -E 's/.*\(([0-9A-F-]{36})\).*/\1/')
[ -n "$udid" ] || { echo "No available simulator named $1${2:+ on $2}" >&2; exit 1; }
echo "$udid"
