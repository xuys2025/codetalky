#!/usr/bin/env bash
# Build the device firmware inside WSL (ESP-IDF v5.5.4 from tools/esp/install-idf.sh):
#
#   bash firmware/build.sh            # build
#   bash firmware/build.sh clean      # wipe the build directory first
#
# The sources are copied to the Linux filesystem first (building from /mnt/d is
# slow); the images land in firmware/out/ for firmware/flash.ps1 on Windows.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ESP="$HOME/esp"
IDF="$ESP/esp-idf-v5.5.4"
WORK="${CT_FW_WORK:-$HOME/work/codetalky}"
BUILD="$WORK/build"
OUT="$ROOT/firmware/out"

export PATH="$ESP/pybin:$PATH"
export IDF_GITHUB_ASSETS="dl.espressif.com/github_assets"
# IDF's environment check runs openocd, which needs the libusb unpacked by install-idf.sh.
if [ -d "$ESP/libusb" ]; then
  LIBUSB_DIR="$(dirname "$(find "$ESP/libusb" -name 'libusb-1.0.so.0' | head -1)")"
  export LD_LIBRARY_PATH="$LIBUSB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
# shellcheck disable=SC1091
. "$IDF/export.sh" >/dev/null

if [ ! -f "$ROOT/ui/fonts/gen/ct_fonts.h" ]; then
  echo "fonts missing: run tools/fontpack/build_fonts.py first (see README)" >&2
  exit 1
fi

mkdir -p "$WORK/third_party"
sync_dir() {
  rsync -a --delete "$@"
}
sync_dir --exclude out/ --exclude build/ --exclude managed_components/ --exclude sdkconfig \
  --exclude sdkconfig.old "$ROOT/firmware/" "$WORK/firmware/"
sync_dir "$ROOT/ui/" "$WORK/ui/"
sync_dir "$ROOT/third_party/monocypher/" "$WORK/third_party/monocypher/"

if [ "${1:-}" = "clean" ]; then
  rm -rf "$BUILD"
fi

cd "$WORK/firmware"
# sdkconfig lives in the build directory, made from sdkconfig.defaults.
idf.py -B "$BUILD" -D SDKCONFIG="$BUILD/sdkconfig" build

# Component versions actually used (idf_component.yml pins LVGL exactly).
for f in "$WORK"/firmware/managed_components/*/idf_component.yml; do
  echo "$(basename "$(dirname "$f")") $(grep -m1 '^version:' "$f" | tr -d '"' | cut -d' ' -f2)"
done

mkdir -p "$OUT"
cp "$BUILD/bootloader/bootloader.bin" "$BUILD/partition_table/partition-table.bin" \
  "$BUILD/ota_data_initial.bin" "$BUILD/codetalky.bin" "$BUILD/codetalky.elf" "$OUT/"
ls -la "$OUT"
python - "$BUILD/codetalky.bin" <<'PY'
import os, sys
size = os.path.getsize(sys.argv[1])
print(f"app image {size / 1024:.0f} KB of 5120 KB ({size * 100 // (5 * 1024 * 1024)}%)")
PY
