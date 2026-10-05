#!/bin/sh
# Refresh the snapshot shipped in the app: the group index, and every group
# carrying a tag the default preset enables, as the worker serves them now. It is
# what a first launch shows before the worker has answered, so refresh it before a
# release. API picks another worker.
#
# Everything is fetched and checked in a scratch folder first, and the snapshot
# replaced only once all of it is in: a failure part way, or an HTML page where
# JSON was asked for, leaves the snapshot as it was.
set -eu

API="${API:-https://satvis.space}"
DIR="$(dirname "$0")/../SatvisKit/Sources/SatvisData/Snapshot"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/gp"

curl -fsS "$API/api/groups.json" -o "$work/groups.json"
groups=$(python3 - "$work/groups.json" <<'EOF'
import json, sys
index = json.load(open(sys.argv[1]))
tags = set(filter(None, index["presets"]["default"].get("defaults", {}).get("tags", "").split(",")))
print(" ".join(group["name"] for group in index["groups"] if tags & set(group.get("tags", []))))
EOF
)
for group in $groups; do
    curl -fsS "$API/api/gp/$group.json" -o "$work/gp/$group.json"
done
# Every group a JSON array of element sets.
python3 - "$work"/gp/*.json <<'EOF'
import json, sys
for path in sys.argv[1:]:
    if not isinstance(json.load(open(path)), list):
        sys.exit(f"{path}: not a list of element sets")
EOF

mkdir -p "$DIR/gp"
rm -f "$DIR"/gp/*.json
mv "$work"/gp/*.json "$DIR/gp/"
mv "$work/groups.json" "$DIR/groups.json"
echo "Snapshot of $API: $groups"
