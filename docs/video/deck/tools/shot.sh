#!/bin/bash
# Renders one slide of a deck folder to a PNG (1920x1080) with headless Chrome, using the local
# preview page (an approximation of the real Slides renderer: see preview.py).
#   shot.sh <root> <slide-id> <out.png> [builds]
# <root> holds project/deck.json and project/slides/<id>.html. Pass "builds" as a fourth argument
# to number the elements that build in. Also prints the preview's overflow report as JSON.
set -euo pipefail
ROOT="$1"; ID="$2"; OUT="$3"; BUILDS="${4:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/deckshot.XXXXXX")"
python3 -I "$HERE/preview.py" "$ROOT" "$WORK/p.html" > /dev/null
QUERY="s=$ID"; [ -n "$BUILDS" ] && QUERY="$QUERY&builds=1"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
  --user-data-dir="$WORK/profile" --window-size=1920,1080 --force-device-scale-factor=1 \
  --virtual-time-budget=6000 --screenshot="$OUT" "file://$WORK/p.html?$QUERY" > /dev/null 2>&1 || true
"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir="$WORK/profile2" --window-size=1920,1080 --virtual-time-budget=6000 \
  --dump-dom "file://$WORK/p.html?$QUERY&report=1" 2>/dev/null | sed -n 's/.*<pre id="report">\(.*\)<\/pre>.*/\1/p' | head -c 4000 || true
rm -rf "$WORK"
[ -s "$OUT" ] && echo "wrote $OUT" || { echo "no screenshot was written"; exit 1; }
