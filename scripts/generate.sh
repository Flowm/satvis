#!/usr/bin/env bash
# Run one of the containerised asset generators.
#
#   pnpm update-imagery          the offline base map      (scripts/imagery)
#   pnpm update-starmap          the sky box faces         (scripts/starmap)
#
# Arguments after the target pass through to the generator, which documents its own flags.
# The two are not chained: together they download 734 MB, and no case needs both.
#
#   - source downloads go to the generator's .cache, never under data/, which ships wholesale
#   - output directories are committed with a .gitignore, because docker would create
#     a missing bind-mount target owned by root
#   - the reference assets are optional and read-only, and never change the output
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
TARGET="${1-}"
shift || true

case "$TARGET" in
  imagery)
    IMAGE="satvis-imagery:1"
    OUT_DIR="$REPO_ROOT/data/imagery"
    REF_DIR="$REPO_ROOT/scripts/.reference/cesium-assets/imagery/NaturalEarthII"
    REF_SKIPS="the colour comparison against the tileset it replaces"
    ;;
  starmap)
    IMAGE="satvis-starmap:1"
    OUT_DIR="$REPO_ROOT/data/starmap"
    REF_DIR="$REPO_ROOT/scripts/.reference/cesium-assets/stars/TychoSkymapII.t3_08192x04096"
    REF_SKIPS="the orientation check against the Tycho faces"
    ;;
  *)
    echo "usage: ${0##*/} <imagery|starmap> [generator options...]" >&2
    echo "       normally reached as \`pnpm update-imagery\` or \`pnpm update-starmap\`." >&2
    exit 2
    ;;
esac

CONTEXT="$REPO_ROOT/scripts/$TARGET"
CACHE_DIR="$CONTEXT/.cache"

if ! docker info >/dev/null 2>&1; then
  echo "docker is not running — these generators keep their toolchains off the host" >&2
  echo "by doing all the work in a container." >&2
  exit 1
fi

for dir in "$CACHE_DIR" "$OUT_DIR"; do
  [ -d "$dir" ] && continue
  echo "missing tracked directory: ${dir#"$REPO_ROOT"/}" >&2
  echo "it is committed with a .gitignore inside; restore it with git checkout." >&2
  exit 1
done

echo "building $IMAGE"
docker build --quiet --tag "$IMAGE" "$CONTEXT" >/dev/null

REF_MOUNT=()
if [ -d "$REF_DIR" ]; then
  REF_MOUNT=(--volume "$REF_DIR:/ref:ro")
else
  echo "note: no reference assets, so $REF_SKIPS will be skipped. To enable it:"
  echo "      git clone --depth 1 https://github.com/Flowm/cesium-assets scripts/.reference/cesium-assets"
fi

# --user, so the output is not owned by root.
exec docker run --rm --init \
  --user "$(id -u):$(id -g)" \
  --volume "$CACHE_DIR:/cache" \
  --volume "$OUT_DIR:/out" \
  "${REF_MOUNT[@]}" \
  "$IMAGE" "$@"
