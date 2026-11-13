#!/usr/bin/env bash
# Render every screen with the fake agent's demo data into design/renders/ui-*.png.
# Needs the simulator built (simulator/build.sh) and Node 22.18+.
#
#   bash simulator/tools/render-ui.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/design/renders"
snap() {
  local name="$1"
  shift
  node "$ROOT/simulator/tools/snapshot.mjs" "$OUT/ui-$name.png" "$@" | grep -v '^vibrate'
}

# List rows are 104 px tall from y=92; detail tabs sit at y=120.
ROW1=240,144 ROW2=240,248 ROW3=240,352 ROW4=240,456 ROW5=240,560

snap 01-list
snap 02-overview --tap $ROW5
snap 03-activity --tap $ROW5 --tap 240,120
snap 04-changes --tap $ROW5 --tap 400,120
snap 05-approve --tap $ROW2
snap 06-question --tap $ROW1
snap 07-done --tap $ROW4
snap 08-reply --tap $ROW4 --tap 426,762
snap 09-voice --tap $ROW4 --tap 426,762 --tap 240,600
snap 10-risky --ms 50000 --tap $ROW3
snap 11-error --tap $ROW3
snap 12-after-approve --tap $ROW2 --tap 360,756
snap 13-offline --offline
# Two computers (台式机, 笔记本), three demo sessions each.
snap 14-two-computers --hosts 2
snap 15-two-approve --hosts 2 --tap $ROW2
snap 16-one-offline --hosts 2 --unlink 1
