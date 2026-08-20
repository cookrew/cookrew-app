#!/bin/sh
# Mounts the REAL CheckpointTimeline with the contract-v2 contiguous fixture and
# measures the pin geometry the reference set asserts. The reference generator
# measures the MOCK; this is the only thing that measures the PRODUCT rail.
#
#   sh scratchpad/pin-marker-acceptance/run.sh
#
# PASS = pinsInsideRail true, coLocatedSpreadPx 0, f6PairDeltaPx 0,
#        labels V1 / V2 / "12" / "" (bare).
set -e
OUT=$(mktemp -d)
npx esbuild scratchpad/pin-marker-acceptance/harness.tsx --bundle \
  --outfile="$OUT/bundle.js" --loader:.css=css --jsx=automatic --log-level=error \
  --define:process.env.NODE_ENV='"production"'
cp scratchpad/pin-marker-acceptance/index.html "$OUT/index.html"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu \
  --allow-file-access-from-files --virtual-time-budget=6000 --window-size=1000,600 \
  --dump-dom "$OUT/index.html" 2>/dev/null | sed -n '/<pre id="P">/,/<\/pre>/p' | sed 's/<[^>]*>//g'
rm -rf "$OUT"
