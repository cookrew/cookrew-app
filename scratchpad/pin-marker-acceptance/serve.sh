#!/bin/sh
# Build the harness and serve it on :8647 for scratchpad/pin-tap-probe.mjs.
#   sh scratchpad/pin-marker-acceptance/serve.sh &
set -e
OUT=/tmp/pin-acc-serve
mkdir -p "$OUT"
npx esbuild scratchpad/pin-marker-acceptance/harness.tsx --bundle \
  --outfile="$OUT/bundle.js" --loader:.css=css --jsx=automatic --log-level=error \
  --define:process.env.NODE_ENV='"production"'
cp scratchpad/pin-marker-acceptance/index.html "$OUT/index.html"
cd "$OUT" && python3 -m http.server 8647 --bind 127.0.0.1
