#!/usr/bin/env bash
set -u
cd "${0%/*}"

# Script to collect custom data for the satvis build
# Data located within the custom/output folder will be copied to data during the webpack build
DATA_DIR="$(readlink -f ../)"
OUT_DIR="$(readlink -f dist)"

# Iterates through all subfolders of this folder
for dir in */; do
  # Executes sync.sh if it exists in that folder
  sync=${dir}sync.sh
  if [ -f "$sync" ]; then
    echo "Running $sync"
    bash $sync "$DATA_DIR" "$OUT_DIR"
  fi
done

exit 0
