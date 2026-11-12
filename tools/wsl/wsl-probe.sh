#!/usr/bin/env bash
# Read-only probe of the WSL environment: tools, disk, network reachability.
echo "== os"; . /etc/os-release; echo "$PRETTY_NAME"
echo "== tools"
for t in git cmake make ninja gcc g++ python3 pip3 curl unzip xz emcc node idf.py; do
  p=$(command -v "$t" 2>/dev/null) || p="(none)"
  echo "$t: $p"
done
python3 --version 2>&1
echo "== home"; ls -d ~/emsdk ~/esp 2>/dev/null || echo "no ~/emsdk or ~/esp"
echo "== net"
for u in https://github.com https://storage.googleapis.com/webassembly/emscripten-releases-builds/ https://dl.espressif.com/dl/ https://pypi.org/simple/pip/; do
  code=$(curl -m 12 -s -o /dev/null -w "%{http_code} %{time_total}s" "$u" 2>/dev/null) || code="fail"
  echo "$u -> $code"
done
echo "== proxy env"
env | grep -i -E '^(https?|all|no)_proxy=' | sed -E 's#//[^@/]*@#//***@#' || echo "(none)"
echo "== sudo"
sudo -n true 2>/dev/null && echo "passwordless sudo: yes" || echo "passwordless sudo: no"
echo "== user"; id -un
