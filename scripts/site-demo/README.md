# The site's pictures, on demo data

Every picture on cookrew.dev since 2026-11-17 comes from here: the current interface, rendered from this
repository's code on a synthetic demo cast, and labelled on the site as an illustration (registry/src/site-frames.ts).
No workspace, machine, account, path or session of anybody's is in it.

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
3. Stills, at a density that lets each be cropped to its subject without scaling up (`DSF=<scale>`, default 2):
   - desktop stops, 1024×640 ×6, prefix `h`: h-devices, h-workspaces, h-docs, h-agents, h-hitl, h-artifacts, h-browser,
     h-board (the BOARD, from `.cr-board-badge`);
   - 1440×900 ×4, prefix `h`: h-peek (the question from the dock, over all four faces) and h-routing;
   - phone, 390×844 ×3, prefix `p`: p-devices, p-workspaces, p-crew, p-card.
   The operation cards: `node scripts/site-demo/ops.mjs` (1024×640 ×2.8125). The canvas clip: `node scripts/site-demo/clip.mjs
   $SHOOT_DIR/canvas.mp4` (1024×640: a screencast sends CSS pixels whatever the scale, so the site never shows it wider).
4. Watch: copy `watch/` elsewhere, `python3 -I scripts/site-demo/watch-neutral.py <copy>/Sources/watch-shots/Shots.swift`,
   then `swift run watch-shots $SHOOT_DIR/watch` in the copy (a debug build: the staging helpers are DEBUG-only).
5. Composites: `node scripts/site-demo/compose.mjs` (hero and hero-phone, ops and ops-phone-stack, watch-phone).
6. `node scripts/site-demo/assets.mjs registry/assets/site` crops every frame (the CSS-px boxes are in the script), writes
   it at up to 2880 with 1440/800 twins and a -phone framing where one is needed, and regenerates
   registry/src/site-frame-sizes.ts; then `node scripts/site-og.mjs` (no port: a fresh Chrome) redraws og-site.jpg.

Working files go to `$SHOOT_DIR` (default /tmp/cookrew-site-demo).
