#!/usr/bin/env bash
# Install ESP-IDF v5.5.4 for ESP32-S3 inside WSL (or any Linux), then check that the
# vendor firmware builds unchanged. Safe to re-run: finished steps are skipped.
#
#   bash tools/esp/install-idf.sh 2>&1 | tee ~/esp/install.log
#
# Environment:
#   CT_PROXY   proxy for GitHub (default: the Windows host's port 7897 when in WSL).
#              Espressif's own mirror (dl.espressif.com) and PyPI are used without it.
set -euo pipefail

IDF_VERSION=v5.5.4
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ESP="$HOME/esp"
IDF="$ESP/esp-idf-$IDF_VERSION"
WORK="$HOME/work/metalio"
step() { printf '\n=== %s  %s\n' "$(date +%H:%M:%S)" "$*"; }

if [ -z "${CT_PROXY:-}" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  CT_PROXY="http://$(ip route show default | awk '{print $3}'):7897"
fi
mkdir -p "$ESP"

# 1. Python 3.12: ESP-IDF 5.5's requirements are not all ready for the system's 3.14.
step "python 3.12"
if [ ! -x "$ESP/uv/bin/uv" ]; then
  python3 -m venv "$ESP/uv"
  "$ESP/uv/bin/pip" install --quiet uv
fi
https_proxy="${CT_PROXY:-}" "$ESP/uv/bin/uv" python install 3.12
PY="$("$ESP/uv/bin/uv" python find 3.12)"
mkdir -p "$ESP/pybin"
ln -sf "$PY" "$ESP/pybin/python3"
ln -sf "$PY" "$ESP/pybin/python"
export PATH="$ESP/pybin:$PATH"
python3 --version

# 2. ESP-IDF itself, from Espressif's mirror (the zip includes the submodules).
step "esp-idf $IDF_VERSION"
if [ ! -f "$IDF/export.sh" ]; then
  ZIP="$ESP/esp-idf-$IDF_VERSION.zip"
  if [ ! -s "$ZIP" ]; then
    wget -q --show-progress -O "$ZIP.part" \
      "https://dl.espressif.com/github_assets/espressif/esp-idf/releases/download/$IDF_VERSION/esp-idf-$IDF_VERSION.zip"
    mv "$ZIP.part" "$ZIP"
  fi
  unzip -q "$ZIP" -d "$ESP"
fi

# 3. Toolchain and Python environment for the ESP32-S3, tools from the mirror too.
#    openocd (for flashing over JTAG) needs libusb; without sudo, unpack Ubuntu's
#    package next to the tools instead of installing it.
step "install.sh esp32s3"
if ! ldconfig -p | grep -q 'libusb-1.0.so.0'; then
  if [ ! -d "$ESP/libusb/usr" ]; then
    (cd "$ESP" && apt-get download libusb-1.0-0 >/dev/null && dpkg -x libusb-1.0-0_*.deb "$ESP/libusb")
  fi
  export LD_LIBRARY_PATH="$(dirname "$(find "$ESP/libusb" -name 'libusb-1.0.so.0' | head -1)")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
export IDF_GITHUB_ASSETS="dl.espressif.com/github_assets"
"$IDF/install.sh" esp32s3

# 4. The vendor firmware, cloned on the Linux side so its symlinks are real.
step "vendor firmware"
if [ ! -d "$WORK/.git" ]; then
  mkdir -p "$(dirname "$WORK")"
  git clone --quiet "$ROOT/Metalio-E-INK4" "$WORK"
fi

# 5. Build it as shipped: checked-in sdkconfig, no set-target.
step "idf.py build"
# shellcheck disable=SC1091
. "$IDF/export.sh" >/dev/null
# The vendor's image packer (esp_mmap_assets) needs qoi-conv; its own auto-install
# did not work here, so put it in IDF's Python environment up front.
python -c 'import importlib; importlib.import_module("qoi-conv.qoi")' 2>/dev/null || python -m pip install -q qoi-conv
cd "$WORK"
https_proxy="${CT_PROXY:-}" idf.py build
step "done"
ls -la "$WORK/build/"*.bin
