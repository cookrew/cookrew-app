# The site's pictures, on demo data

Every picture on cookrew.dev since 2026-11-17 comes from here: the current interface, rendered from this
repository's code on a synthetic demo cast (registry/src/site-frames.ts). Since 2026-11-18 (owner) a picture carries no
chip and no caption; the markup keeps `data-source`. Every frame has a day and a night take (`-night`, the app's night
palette), shown by the reader's scheme or the header's Auto/Day/Night pick. No workspace, machine, account, path or session of anybody's is in it.

The cast: workspace **Release Room** (Planner on Claude Code, the orch, waiting on a permission prompt to edit
CHANGELOG.md; Reviewer on Codex, working; Checker on OpenCode, replied; Notes on Pi, resting; a note, a browser card on
`pages/release-notes.html` served as `http://notes.example/`, a computer and a phone screen card) and **Docs Site**
(Writer, Editor). Machines: Studio Mac (this one) and Build Server, read through its own fleet snapshot (Nightly Builds:
Builder, Triage). Checker is wired to the browser card and both screen cards. The Routing panel reads a cleaned copy of
shared/route-fixture.ts (no email, generic group names, no MCP servers).

1. `node scripts/site-demo/serve.mjs` (renderer on the demo api + `fixture/seed.ts`, port 5397; restart it after
   editing the seed) and `python3 -m http.server 5398 --bind 127.0.0.1 --directory scripts/site-demo/pages`.
2. A headless Chrome with `--remote-debugging-port=9334`, its own `--user-data-dir`, `--no-proxy-server` and
   `"--host-resolver-rules=MAP notes.example 127.0.0.1:5398"`. Never the Cookrew app.
3. Stills: `scripts/site-demo/shoot-all.sh <dir>` takes every one (desktop stops at 1024×640 ×6 with Docs Site at ×8,
   the dock's question and Routing at 1440×900 ×4, phone stops at 390×844 ×3), then runs `ops.mjs` (the operation cards)
   and `compose.mjs`. `NIGHT=1 scripts/site-demo/shoot-all.sh <night dir>` is the same walk in the night palette
   (cdp.mjs emulates a dark scheme and holds the app on `auto`). The devices stop needs no composite: the current renderer
   draws each machine's workspaces on its screen, so assets.mjs crops it.
   The canvas clip: `CDP_PORT=9335 node scripts/site-demo/clip.mjs <dir>/canvas.mp4` (and `NIGHT=1` for the night one),
   against a HEADFUL Chrome on a 2× display (a headless one screencasts CSS pixels only; the script stops if the frames are
   not 2048 wide): its own profile, the same proxy and host flags, parked off screen (see the top of clip.mjs). Each step
   is cropped; the clip is 1280×800.
4. Watch: copy `watch/` elsewhere, `python3 -I scripts/site-demo/watch-neutral.py <copy>/Sources/watch-shots/Shots.swift`,
   then `swift run watch-shots $SHOOT_DIR/watch` in the copy (it writes the night screens, `w45n-*`, too) (a debug build: the staging helpers are DEBUG-only).
5. Composites: `node scripts/site-demo/compose.mjs` (run by shoot-all.sh; the hero is the laptop, phone and watch in equal
   28 px bezels, bottoms aligned; hero-phone, ops and ops-phone-stack, watch-phone).
6. `SHOOT_DIR=<day dir> NIGHT_DIR=<night dir> node scripts/site-demo/assets.mjs registry/assets/site` crops every frame (the CSS-px boxes are in the script), writes
   it at up to 2880 with 1440/800 twins and a -phone framing where one is needed, and regenerates
   registry/src/site-frame-sizes.ts; then `node scripts/site-og.mjs` (no port: a fresh Chrome) redraws og-site.jpg.

Working files go to `$SHOOT_DIR` (default /tmp/cookrew-site-demo).
