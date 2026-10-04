#!/bin/sh
# Refresh the snapshot shipped in the app: the group index, and every group
# carrying a tag the default preset enables, as the worker serves them now. It is
# what a first launch shows before the worker has answered, so refresh it before a
# release. API picks another worker.
set -eu

API="${API:-https://satvis.space}"
DIR="$(dirname "$0")/../SatvisKit/Sources/SatvisData/Snapshot"

mkdir -p "$DIR/gp"
curl -fsS "$API/api/groups.json" -o "$DIR/groups.json"
groups=$(python3 - "$DIR/groups.json" <<'EOF'
import json, sys
index = json.load(open(sys.argv[1]))
tags = set(filter(None, index["presets"]["default"].get("defaults", {}).get("tags", "").split(",")))
print(" ".join(group["name"] for group in index["groups"] if tags & set(group.get("tags", []))))
EOF
)
rm -f "$DIR"/gp/*.json
for group in $groups; do
    curl -fsS "$API/api/gp/$group.json" -o "$DIR/gp/$group.json"
done
echo "Snapshot of $API: $groups"
