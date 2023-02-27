#!/usr/bin/env bash
# Sample script to add additional satellite TLEs from other sources
set -u
cd "${0%/*}"

DATA_DIR=$1
TLE_DIR=${DATA_DIR}/tle
OUT_DIR=$2/tle
mkdir -p "$OUT_DIR"

egrep -A2 '(FIRST-MOVE|MOVE-II)' --no-group-separator "${TLE_DIR}/groups/active.txt" > "${OUT_DIR}/move.txt"
