#!/usr/bin/env bash
# Install the Emscripten SDK into ~/emsdk inside WSL.
# GitHub is only usable from WSL through the Windows host proxy, so the proxy is
# set for this script's processes only (no system or shell config is changed).
set -euo pipefail
HOST_IP=$(ip route show default | awk '{print $3}')
export https_proxy="http://${HOST_IP}:7897" http_proxy="http://${HOST_IP}:7897"

cd ~
if [ ! -d emsdk/.git ]; then
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git
fi
cd emsdk
./emsdk install latest
./emsdk activate latest
# shellcheck disable=SC1091
source ./emsdk_env.sh >/dev/null 2>&1
echo "== installed"
emcc --version | head -1
node --version
du -sh ~/emsdk | cut -f1
