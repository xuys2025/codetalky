#!/usr/bin/env bash
# Our changes to LVGL, applied on top of the release both builds use (the simulator's
# checkout, the firmware's managed component). A patch already in the tree is skipped.
#
#   bash third_party/lvgl-patches/apply.sh <lvgl-dir>
#
# 0001-cjk-line-break: closing punctuation never starts a line, an opening bracket
# never ends one (LVGL breaks Chinese text before or after any character).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="$1"
for p in "$HERE"/*.patch; do
  if patch -p1 -d "$DIR" -R -s -f --dry-run <"$p" >/dev/null 2>&1; then
    continue # in the tree already
  fi
  patch -p1 -d "$DIR" -s -N <"$p"
  echo "LVGL: applied $(basename "$p")"
done
