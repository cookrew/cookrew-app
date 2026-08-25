#!/usr/bin/env node
/**
 * F6 / B3r REFERENCE SET — captured from the PRODUCT rail, at the size the
 * product rail actually renders.
 *
 *   node scratchpad/f6-reference/render-f6-reference.mjs
 *
 * WHY THIS WAS REWRITTEN. The previous set was captured from the DESIGN MOCK,
 * and Magpie measured every band at 1120x416 against a live rail of 30x663. A
 * diff between those two can only ever report a size mismatch, whatever the
 * geometry does — so the reference was unusable as a reference no matter how
 * carefully it had been measured. This mounts the real CheckpointTimeline (via
 * scratchpad/pin-marker-acceptance) on a stage the rail's true height and clips
 * every band to the rail's own 30px box.
 *
 * NO .on-cream STATE. The rail's light-chrome variant is CSS that nothing in
 * the renderer mounts — only GitChip uses an on-cream class, never the rail. A
 * reference for a state the product cannot reach would be a picture of my own
 * test harness, and adding the class imperatively does not work anyway: React
 * owns that className and overwrites it on the next render.
 *
 * BANDS MAY LEGITIMATELY COINCIDE. The band is a 30px crop centred on the PIN,
 * so two states that differ only in where the thumb sits elsewhere on the bar
 * produce the same band by construction — 2-fan-open and 6-colocated do. Check
 * duplicates among the WIDE shots, which capture the whole rail and must all
 * differ; a duplicate there is the "same picture six times" failure.
 *
 * CO-LOCATION AFTER c0e6d5f. A trace boundary anchors at the edge BELOW its
 * checkpoint, so `afterIndex` must name the checkpoint BEFORE the pin for all
 * three classes to share a Y: traceFraction(4, rows) === pinFraction(5, rows).
 * The harness pairs a compact after T4 with pin v2 on T5 for exactly that.
 *
 * AND IN BOTH ROW SHAPES. That pairing is on the CONTIGUOUS ledger, where array
 * position and turn number agree — the shape the fixture says is "exactly why
 * the v1 bug went unnoticed", and therefore the shape in which a regression to
 * v1 anchoring is invisible. 7-colocated-noncontiguous repeats it on rows
 * 1,2,4,7, where the two spaces diverge, with the boundary's checkpoint DERIVED
 * from the same functions the rail lays itself out with.
 *
 * THE FIXTURE IS IMPORTED, NOT RESTATED. The harness reads
 * tests/fixtures/version-pins.json and publishes what it read on window.
 * __fixture; this file records that per state and fails on an unexpected
 * contract version. The previous set asserted a fixture path the harness never
 * opened, over a hardcoded copy that had already drifted from it.
 *
 * A MISSING MEASUREMENT IS A FAILURE. Each state declares `requires` (and
 * `forbids`), checked BEFORE any delta is read — see the note on ALL_MARKS.
 *
 * DEPENDENCY: scratchpad/qa-cdp-driver.mjs (Magpie's, untracked). Copy it in
 * beside this file if it is missing.
 *
 * PORTS: Chrome 9336, harness 8646. Never Magpie's 9245 or 8648 (a live node
 * bridge), never the pin probe's 8647, never :8639 / :8643 / :5173.
 *
 * IT VERIFIES ITS OWN SERVER BEFORE MEASURING ANYTHING. A previous run pointed
 * at 8648, where python failed to bind (EADDRINUSE, silently backgrounded) and
 * a different process answered — so "the rail did not mount" was a true reading
 * of somebody else's server. Same trap as the clip-coordinate bug, one layer
 * down: check what the server IS before trusting what it shows.
 */
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp } from '../qa-cdp-driver.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const OUT = HERE
const CDP_PORT = 9336
const HTTP_PORT = 8646
const SERVE_DIR = '/tmp/f6-refs-serve'
const PROFILE = '/tmp/f6-refs-profile'
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** The live rail, as Magpie measured it. The stage is sized so the rail matches. */
const RAIL_W = 30
const RAIL_H = 663
/** Pin contract this set is captured against. The harness IMPORTS the fixture
 *  and publishes what it read, so a bump lands here as a loud failure rather
 *  than as a stale reference still claiming the old version. */
const EXPECT_CONTRACT = 2
const VIEWPORT = { width: 1000, height: RAIL_H + 40, deviceScaleFactor: 2 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * `requires` NAMES THE MARKS EACH STATE MUST PHOTOGRAPH.
 *
 * The gate at the bottom used to read only the two deltas, and skipped a null:
 * `markerClassSpreadPx !== null && >= 0.5`. So if `.cr-ckpt-here` or
 * `.cr-ckpt-row.active` ever stopped matching — a class rename, a DOM
 * restructure — f6PairDeltaPx went null, the console printed `f6Pair=n/a`, and
 * the run EXITED 0 announcing "All measured states within 0.5px". F6 disarmed
 * silently, not by capturing a mock but by measuring nothing and calling it a
 * pass. `absentMarks` was recorded the whole time and never asserted on.
 *
 * Per-state rather than blanket, because 5-empty-ledger legitimately has no pin
 * — that absence is the thing it exists to prove. A blanket "all four present"
 * would have to special-case it anyway, and a special case in a gate is where
 * the next silent pass comes from.
 */
const ALL_MARKS = ['pin', 'trace', 'thumb', 'focusRow']

const STATES = [
  { id: '1-rail-at-rest', label: 'pins on the bar, nothing revealed', url: '', requires: ALL_MARKS },
  // HOLD, not release. On mouseup the component re-derives `focused` from its
  // activeIndex/markerFrac props, so the reveal closes and the thumb snaps back
  // — a released state photographs the rail at rest, whatever you scrubbed to.
  // The first run of this rewrite shipped 2 and 4 as byte-identical because of
  // exactly that, and the duplicate-hash check is what caught it.
  // Held at 0.55, which is NOT a pin fraction: the reveal open with the thumb
  // clear of every pin. Held at 0.4 it was byte-identical to state 3, because
  // 0.4 IS the coincident-pin case — two names for one picture.
  { id: '2-fan-open', label: 'reveal open, thumb clear of every pin — the F6 pair', url: '', scrub: true, hold: true, moveThumbTo: 0.55, requires: ALL_MARKS },
  { id: '3-thumb-on-pin', label: 'thumb held on its coincident pin (R25: the thumb owns it)', url: '', scrub: true, hold: true, requires: ALL_MARKS },
  // The pin is absent BY DESIGN here, and that absence is the assertion.
  { id: '5-empty-ledger', label: 'no pins in the ledger — none drawn, none guessed', url: '?empty=1',
    requires: ['trace', 'thumb', 'focusRow'], forbids: ['pin'] },
  // The thumb is moved by PROP, at rest: dragging it away would dim every pin
  // to 55% (the coincidence rule) and photograph the marks faded, and releasing
  // the drag snaps the thumb straight back onto the pin.
  { id: '6-colocated', label: 'B3r REFERENCE — pin + trace boundary on one checkpoint, thumb clear, undimmed',
    url: '?thumb=0.12', requires: ALL_MARKS },
  /**
   * B3r ON NON-CONTIGUOUS ROWS — the regression guard the set was missing.
   *
   * Every other state draws the CONTIGUOUS ledger, where array position and
   * turn number agree; the fixture says so itself ("which is exactly why the v1
   * bug went unnoticed"). A reference set that only ever photographs that shape
   * cannot distinguish R17 render-position anchoring from the v1 turn-number
   * anchoring c0e6d5f removed, so it would pass a regression to v1 without a
   * pixel moving. Rows 1,2,4,7 pull the two spaces apart: checkpoint 4 anchors
   * at 2/4 = 0.5 under R17 and near 4/7 under v1.
   */
  { id: '7-colocated-noncontiguous',
    label: 'B3r on rows 1,2,4,7 — where render space and turn-number space DIVERGE',
    url: '?colocated=1&thumb=0.85', requires: ALL_MARKS }
]

const PROBE = `(() => {
  const box = el => { if (!el) return null; const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return null
    return { x:+r.x.toFixed(2), y:+r.y.toFixed(2), w:+r.width.toFixed(2), h:+r.height.toFixed(2),
             cy:+(r.y + r.height/2).toFixed(2) } }
  const rail = document.querySelector('.cr-ckpt-rail')
  if (!rail) return { railMounted:false }
  const marks = {
    pin:   box(rail.querySelector('.cr-ckpt-pin[data-version="2"]')),
    trace: box(rail.querySelector('.cr-ckpt-tick')),
    thumb: box(rail.querySelector('.cr-ckpt-here')),
    focusRow: box(rail.querySelector('.cr-ckpt-row.active'))
  }
  const names = ['pin','trace'].filter(k => marks[k])
  const ys = names.map(k => marks[k].cy)
  return {
    railMounted:true, railBox: box(rail), railClass: rail.className,
    marks, measuredMarks: names, absentMarks: Object.keys(marks).filter(k => !marks[k]),
    markerClassSpreadPx: ys.length > 1 ? +(Math.max(...ys) - Math.min(...ys)).toFixed(3) : null,
    f6PairDeltaPx: marks.thumb && marks.focusRow ? +Math.abs(marks.thumb.cy - marks.focusRow.cy).toFixed(3) : null,
    pinCount: rail.querySelectorAll('.cr-ckpt-pin').length,
    pinLabels: [...rail.querySelectorAll('.cr-ckpt-pin')].map(e => ({ version:Number(e.dataset.version), text:e.textContent }))
  } })()`

async function shot(cdp, clip) {
  // DOCUMENT-relative clip: captureBeyondViewport resolves against the document
  // origin, and a raw getBoundingClientRect() once produced six identical
  // pictures of body text that sailed through a hash-equality determinism
  // check. Reproducible is not correct.
  const r = await cdp.send('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: true,
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: clip.scale ?? 1 }
  })
  return Buffer.from(r.data, 'base64')
}

async function main() {
  rmSync(SERVE_DIR, { recursive: true, force: true }); mkdirSync(SERVE_DIR, { recursive: true })
  execSync(`npx esbuild scratchpad/pin-marker-acceptance/harness.tsx --bundle ` +
    `--outfile=${SERVE_DIR}/bundle.js --loader:.css=css --jsx=automatic --log-level=error ` +
    `--define:process.env.NODE_ENV='"production"'`, { cwd: REPO, stdio: 'inherit' })
  copyFileSync(resolve(REPO, 'scratchpad/pin-marker-acceptance/index.html'), `${SERVE_DIR}/index.html`)
  // A sentinel this run alone can produce, so a foreign listener cannot pass.
  const SENTINEL = `f6-refs-${process.pid}-${RAIL_H}`
  writeFileSync(`${SERVE_DIR}/whoami.txt`, SENTINEL)
  const server = spawn('python3', ['-m','http.server', String(HTTP_PORT), '--bind','127.0.0.1'],
    { cwd: SERVE_DIR, stdio: 'ignore' })
  let served = null
  for (let i = 0; i < 40 && served !== SENTINEL; i++) {
    await sleep(250)
    try { served = (await fetch(`http://127.0.0.1:${HTTP_PORT}/whoami.txt`).then(r => r.text())).trim() } catch {}
  }
  if (served !== SENTINEL) {
    server.kill()
    throw new Error(`:${HTTP_PORT} is not serving this run's build (got ${JSON.stringify(served)}). ` +
      `Something else owns the port — find it with lsof before assuming a render failure.`)
  }

  rmSync(PROFILE, { recursive: true, force: true })
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`, '--disable-gpu','--no-first-run','--hide-scrollbars','about:blank'], { stdio: 'ignore' })

  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250)
    try { target = (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then(r=>r.json())).find(t=>t.type==='page') } catch {}
  }
  if (!target) throw new Error(`Chrome did not expose a page on :${CDP_PORT}`)

  const report = {
    generatedBy: 'scratchpad/f6-reference/render-f6-reference.mjs',
    capturedFrom: 'the PRODUCT rail (CheckpointTimeline) via scratchpad/pin-marker-acceptance',
    captureScale: { railWidthPx: RAIL_W, railHeightPx: RAIL_H, deviceScaleFactor: VIEWPORT.deviceScaleFactor },
    // The path only. The CONTRACT VERSION and the row shape are recorded
    // per-state from window.__fixture — i.e. from what the harness actually
    // read — because this line used to assert a fixture the harness never
    // opened, while its own hardcoded copy had already drifted from it.
    fixtureSource: 'tests/fixtures/version-pins.json (imported by the harness, post c0e6d5f)',
    states: []
  }

  for (const state of STATES) {
    const cdp = await connectCdp(target.webSocketDebuggerUrl)
    try {
      await cdp.send('Page.enable')
      await cdp.send('Emulation.setDeviceMetricsOverride', { mobile:false, ...VIEWPORT })
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${HTTP_PORT}/index.html${state.url}` })
      await cdp.waitForEvent('Page.loadEventFired')
      // Long enough for the F1 idle fade to have STARTED and FINISHED. It is a
      // timer plus a 220ms transition, so a shorter settle captures the rail
      // mid-fade and the shot differs run to run — which is what broke
      // reproducibility on the at-rest state the first time.
      await sleep(state.scrub ? 1500 : 3200)

      const rail = (await cdp.send('Runtime.evaluate', { returnByValue:true, expression:
        `(()=>{const r=document.querySelector('.cr-ckpt-rail');if(!r)return null;const b=r.getBoundingClientRect()
          return {dx:b.x+scrollX, dy:b.y+scrollY, w:b.width, h:b.height, vx:b.x+b.width/2, vy:b.y}})()` })).result.value
      if (!rail) throw new Error(`${state.id}: rail did not mount`)

      if (state.scrub) {
        const x = Math.round(rail.vx)
        const at = (f) => Math.round(rail.vy + 16 + f * (rail.h - 32))
        await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x, y: at(0.4) }); await sleep(200)
        await cdp.send('Input.dispatchMouseEvent', { type:'mousePressed', x, y: at(0.4), button:'left', clickCount:1 })
        for (const f of [0.4, 0.42, 0.4]) {
          await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x, y: at(f), button:'left' }); await sleep(150)
        }
        if (state.moveThumbTo !== undefined) {
          await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved', x, y: at(state.moveThumbTo), button:'left' }); await sleep(250)
        }
        if (!state.hold) {
          await cdp.send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y: at(state.moveThumbTo ?? 0.4), button:'left' }); await sleep(300)
        }
      }

      // FREEZE ANIMATION BEFORE CAPTURING. `.cr-ckpt-livedot` runs cr-ckpt-pulse
      // on an infinite loop, so every shot caught it at a different phase and
      // the at-rest reference hashed differently on every run. A reference image
      // with a live animation in it cannot be pixel-diffed at all — which is
      // precisely what Magpie's B6 hashes need it to be. Removing the animation
      // is deliberate: the glow is not what the geometry gates measure.
      await cdp.send('Runtime.evaluate', { expression:
        `(()=>{const st=document.createElement('style')
          st.textContent='*,*::before,*::after{animation:none !important;transition:none !important}'
          document.head.appendChild(st)})()` })
      await sleep(250)

      const probe = (await cdp.send('Runtime.evaluate', { expression: PROBE, returnByValue:true })).result.value
      // What the harness ACTUALLY rendered, read off the page rather than
      // asserted here. The old report stamped a fixture path it had no evidence
      // for; this is evidence.
      const fixture = (await cdp.send('Runtime.evaluate', {
        expression: 'window.__fixture', returnByValue: true })).result.value
      if (!fixture) throw new Error(`${state.id}: harness published no __fixture`)
      const scrollDelta = rail.dy - rail.vy   // viewport coords -> document coords

      writeFileSync(resolve(OUT, `${state.id}.png`), await shot(cdp, {
        x: rail.dx - 300, y: rail.dy - 4, width: 300 + rail.w + 4, height: rail.h + 8, scale: 2 }))
      const bandCy = (probe.marks?.pin?.cy ?? probe.marks?.trace?.cy ?? rail.vy + rail.h / 2) + scrollDelta
      writeFileSync(resolve(OUT, `${state.id}--band.png`), await shot(cdp, {
        x: rail.dx - 2, y: bandCy - 26, width: rail.w + 4, height: 52, scale: 4 }))

      report.states.push({
        id: state.id, label: state.label,
        requires: state.requires ?? [], forbids: state.forbids ?? [],
        fixture, ...probe
      })
      const n = (v) => (v === null || v === undefined ? 'n/a' : `${v}px`)
      console.log(`${state.id.padEnd(26)} classes=${n(probe.markerClassSpreadPx).padEnd(6)}` +
        ` f6Pair=${n(probe.f6PairDeltaPx).padEnd(6)} pins=${probe.pinCount}` +
        ` rail=${probe.railBox.w}x${probe.railBox.h} case=${fixture.case}`)
    } finally { cdp.close() }
  }

  writeFileSync(resolve(OUT, 'measurements.json'), JSON.stringify(report, null, 2) + '\n')
  chrome.kill(); server.kill(); await sleep(600)
  try { rmSync(PROFILE, { recursive:true, force:true }) } catch {}

  // ---- gates. A MISSING MEASUREMENT IS A FAILURE, NOT A SKIP. ----
  //
  // The order matters: presence first, then the deltas. Checking a delta before
  // establishing that its two marks exist is how a null came to read as a pass.
  const problems = []

  for (const s of report.states) {
    const absent = s.requires.filter(k => !s.marks?.[k])
    if (absent.length) problems.push(`${s.id}: required mark(s) never rendered — ${absent.join(', ')}`)
    const present = s.forbids.filter(k => s.marks?.[k])
    if (present.length) problems.push(`${s.id}: forbidden mark(s) rendered — ${present.join(', ')}`)

    // Every state requires thumb + focusRow, so F6 must have produced a number.
    // A null here means the pair was not measured, which is the failure the
    // whole reference set exists to make impossible.
    if (s.requires.includes('thumb') && s.requires.includes('focusRow') && s.f6PairDeltaPx === null)
      problems.push(`${s.id}: F6 pair not measured (thumb/focusRow present but no delta)`)
    if (s.requires.includes('pin') && s.requires.includes('trace') && s.markerClassSpreadPx === null)
      problems.push(`${s.id}: marker-class spread not measured (pin/trace present but no delta)`)

    if (s.markerClassSpreadPx !== null && s.markerClassSpreadPx >= 0.5)
      problems.push(`${s.id}: marker classes spread ${s.markerClassSpreadPx}px`)
    if (s.f6PairDeltaPx !== null && s.f6PairDeltaPx >= 0.5)
      problems.push(`${s.id}: F6 pair off by ${s.f6PairDeltaPx}px`)
    if (!s.railBox || Math.round(s.railBox.w) !== RAIL_W)
      problems.push(`${s.id}: rail did not render at ${RAIL_W}px`)
    if (s.fixture?.contractVersion !== EXPECT_CONTRACT)
      problems.push(`${s.id}: fixture contract v${s.fixture?.contractVersion}, expected v${EXPECT_CONTRACT}`)
  }

  // The set must actually contain the non-contiguous case. Deleting that state
  // would otherwise leave a green run that no longer guards the regression.
  if (!report.states.some(s => /non-contiguous/.test(s.fixture?.case ?? '')))
    problems.push('no state rendered the NON-CONTIGUOUS row shape — the v1-anchoring guard is gone')

  if (problems.length) {
    console.log(`FAIL — ${problems.length} problem(s):`)
    for (const p of problems) console.log(`  ${p}`)
    process.exit(1)
  }
  const measured = report.states.reduce((n, s) => n + s.requires.length, 0)
  console.log(`PASS — ${measured} marks present and measured across ${report.states.length} states; ` +
    `every delta < 0.5px; rail ${RAIL_W}x${RAIL_H} in every shot.`)
  process.exit(0)
}

mkdirSync(OUT, { recursive: true })
main().catch(e => { console.error(e); process.exit(1) })
