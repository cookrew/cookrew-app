# The site's pictures, on demo data

Every picture on cookrew.dev since 2026-11-17 comes from here: the current interface, rendered from this
repository's code on a synthetic demo cast, and labelled on the site as an illustration (registry/src/site-frames.ts).
No workspace, machine, account, path or session of anybody's is in it.

The cast: workspace **Release Room** (Planner on Claude Code, the orch; Reviewer on Codex, waiting on a permission
prompt; Checker on OpenCode, replied; Notes on Pi, resting; a note, a browser card on `pages/release-notes.html`,
a computer and a phone screen card) and **Docs Site** (Writer, Editor). Machines on the watch: Studio Mac, Build
Server. The Routing panel reads a cleaned copy of shared/route-fixture.ts (no email, generic group names).

1. `node scripts/site-demo/serve.mjs` (renderer on the demo api + `fixture/seed.ts`, port 5397) and
   `python3 -m http.server 5398 --bind 127.0.0.1 --directory scripts/site-demo/pages`.
2. A headless Chrome with `--remote-debugging-port=9334` and its own `--user-data-dir`. Never the Cookrew app.
3. Stills: `node scripts/site-demo/walk.mjs <prefix> <w> <h> <mobile 0|1> light '<steps>'` (clicks through the
   product's own buttons; see the steps in the commit that added the files). Clip: `node scripts/site-demo/clip.mjs`.
4. Watch: copy `watch/` elsewhere, `python3 -I scripts/site-demo/watch-neutral.py <copy>/Sources/watch-shots/Shots.swift`,
   then `swift run watch-shots <dir>` in the copy (a debug build: the staging helpers are DEBUG-only).
5. `node scripts/site-demo/assets.mjs registry/assets/site` writes the `demo-*` files at 1400 and 800.

Working files go to `$SHOOT_DIR` (default /tmp/cookrew-site-demo).
