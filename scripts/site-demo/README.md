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
3. Stills: `node scripts/site-demo/walk.mjs <prefix> <w> <h> <mobile 0|1> light '<steps>'` — desktop `d` at 1440×900
   (d-devices, d-workspaces, d-agents, d-peek: the question from the dock, d-hitl, d-artifacts), phone `p` at 390×844 (p-1-crew, p-2-card), Routing `r`
   (r-routing). The operation cards: `node scripts/site-demo/ops.mjs`. The canvas clip: `node scripts/site-demo/clip.mjs
   $SHOOT_DIR/canvas.mp4`.
4. Watch: copy `watch/` elsewhere, `python3 -I scripts/site-demo/watch-neutral.py <copy>/Sources/watch-shots/Shots.swift`,
   then `swift run watch-shots $SHOOT_DIR/watch` in the copy (a debug build: the staging helpers are DEBUG-only).
5. Composites: `node scripts/site-demo/compose.mjs` (hero.png: one question on desktop, phone width and watch; ops.png).
6. `node scripts/site-demo/assets.mjs registry/assets/site` writes the `demo-*` files at 1400 and 800, then
   `node scripts/site-og.mjs` (no port: a fresh Chrome, so no cached picture) redraws og-site.jpg.

Working files go to `$SHOOT_DIR` (default /tmp/cookrew-site-demo).
