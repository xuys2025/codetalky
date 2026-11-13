#!/usr/bin/env bash
# Build the simulator: ui/ + simulator/wasm + LVGL -> WebAssembly.
# Run inside WSL (or any Linux) with the Emscripten SDK installed in ~/emsdk:
#
#   bash simulator/build.sh
#
# Environment:
#   CT_CACHE  where LVGL and object files are kept (default ~/.cache/codetalky).
#             Keep it on a Linux filesystem; building under /mnt/* is slow.
#   CT_PROXY  proxy URL, used only for the one-time LVGL download.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SIM="$ROOT/simulator"
CACHE="${CT_CACHE:-$HOME/.cache/codetalky}"
LVGL_TAG="v9.5.0"
LVGL="$CACHE/lvgl-$LVGL_TAG"
BUILD="$CACHE/sim-build"
OUT="$SIM/web/gen"

if ! command -v emcc >/dev/null 2>&1; then
  if [ -f "$HOME/emsdk/emsdk_env.sh" ]; then
    # shellcheck disable=SC1091
    source "$HOME/emsdk/emsdk_env.sh" >/dev/null 2>&1
  else
    echo "emcc not found: install the Emscripten SDK in ~/emsdk first" >&2
    exit 1
  fi
fi

if [ ! -f "$LVGL/lvgl.h" ]; then
  echo "Fetching LVGL $LVGL_TAG into $LVGL"
  mkdir -p "$CACHE"
  https_proxy="${CT_PROXY:-${https_proxy:-}}" \
    git clone --depth 1 -b "$LVGL_TAG" https://github.com/lvgl/lvgl.git "$LVGL"
fi

mkdir -p "$BUILD" "$OUT"

mapfile -t LVGL_SRC < <(find "$LVGL/src" -name '*.c' \
  ! -path '*/drivers/*' ! -path '*/libs/thorvg/*' | sort)
# Third-party C compiled without our warning flags. ESP-IDF ships the same cJSON.
LVGL_SRC+=("$ROOT/third_party/cjson/cJSON.c" "$ROOT/third_party/monocypher/monocypher.c")
if [ ! -f "$ROOT/ui/fonts/gen/ct_fonts.h" ]; then
  echo "fonts missing: run tools/fontpack/build_fonts.py first (see README)" >&2
  exit 1
fi
mapfile -t OWN_SRC < <({ find "$ROOT/ui/src" "$ROOT/ui/fonts/gen" -name '*.c'; find "$SIM/wasm" -name '*.c'; } | sort)

CFLAGS="-O2 -DLV_CONF_INCLUDE_SIMPLE -DLV_LVGL_H_INCLUDE_SIMPLE -I$SIM -I$LVGL -I$ROOT/ui/include -I$ROOT/ui/src -I$ROOT/ui/fonts/gen -I$ROOT/third_party/cjson -I$ROOT/third_party/monocypher"
LDFLAGS="-O2 -sMODULARIZE=1 -sEXPORT_NAME=createCodeTalkySim -sENVIRONMENT=web,node"
LDFLAGS+=" -sALLOW_MEMORY_GROWTH=1 -sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString,stringToUTF8,lengthBytesUTF8"
LDFLAGS+=" -sEXPORTED_FUNCTIONS=_main,_malloc,_free"

obj_for() {
  printf 'obj/%s.o' "$(printf '%s' "${1#/}" | tr '/' '_')"
}

{
  echo "cflags = $CFLAGS"
  echo "ldflags = $LDFLAGS"
  echo "rule cc"
  echo "  command = emcc \$cflags \$warn -MD -MF \$out.d -c \$in -o \$out"
  echo "  depfile = \$out.d"
  echo "  deps = gcc"
  echo "  description = CC \$in"
  echo "rule link"
  echo "  command = emcc \$ldflags @\$out.rsp -o \$out"
  echo "  rspfile = \$out.rsp"
  echo "  rspfile_content = \$in"
  echo "  description = LINK \$out"
  objs=()
  for src in "${LVGL_SRC[@]}"; do
    obj="$(obj_for "$src")"
    objs+=("$obj")
    echo "build $obj: cc $src"
  done
  for src in "${OWN_SRC[@]}"; do
    obj="$(obj_for "$src")"
    objs+=("$obj")
    echo "build $obj: cc $src"
    echo "  warn = -Wall -Wextra"
  done
  echo "build $OUT/codetalky_sim.js: link ${objs[*]}"
  echo "default $OUT/codetalky_sim.js"
} > "$BUILD/build.ninja"

ninja -C "$BUILD"
echo "Built: $OUT/codetalky_sim.js"
