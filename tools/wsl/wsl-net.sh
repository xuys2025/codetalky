#!/usr/bin/env bash
# Read-only network diagnosis from inside WSL.
echo "== resolv"; grep -v '^#' /etc/resolv.conf
echo "== wslconf"; cat /etc/wsl.conf 2>/dev/null || echo "(no /etc/wsl.conf)"
echo "== dns github"; getent hosts github.com || echo "dns fail"
echo "== curl github (30s)"
curl -m 30 -s -o /dev/null -w "http=%{http_code} connect=%{time_connect}s total=%{time_total}s\n" https://github.com || echo "curl exit $?"
echo "== git ls-remote emsdk (40s)"
timeout 40 git ls-remote --heads https://github.com/emscripten-core/emsdk.git main 2>&1 | head -3 || echo "git exit $?"
echo "== gitee"
curl -m 15 -s -o /dev/null -w "http=%{http_code} total=%{time_total}s\n" https://gitee.com || echo "curl exit $?"
echo "== espressif idf zip (HEAD)"
curl -m 20 -sIL -o /dev/null -w "http=%{http_code} total=%{time_total}s\n" https://dl.espressif.com/github_assets/espressif/esp-idf/releases/download/v5.5.4/esp-idf-v5.5.4.zip || echo "curl exit $?"
echo "== host ip (default gw)"; ip route show default | awk '{print $3}'
