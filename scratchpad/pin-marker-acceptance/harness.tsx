import { createRoot } from 'react-dom/client'
import React from 'react'
import { CheckpointTimeline } from '../../src/renderer/src/CheckpointTimeline'
import { pinFraction, traceFraction } from '../../src/shared/version-pin'
import fixture from '../../tests/fixtures/version-pins.json'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/agent-roster.css'

/**
 * THE FIXTURE IS READ, NOT RESTATED.
 *
 * This file used to carry its own copy of the contiguous rows and pins under a
 * comment naming where they came from, and the generator then stamped
 * `fixture: tests/fixtures/version-pins.json contract v2` into measurements.json
 * on the strength of that comment. The copy had already drifted — `cutAt` held
 * 1,2,3,4 against the fixture's epoch millis, `manifestId` was dropped outright
 * — and, worse, the real fixture has a tripwire (tests/version-pin-fixture.test
 * .ts re-derives every expectation from src/shared/version-pin.ts and fails when
 * the file moves) while a hardcoded copy in scratchpad has none. Contract v3
 * could land, the tripwire would catch the fixture, and this reference set would
 * go on claiming to be v2.
 *
 * Reading it makes the claim in measurements.json true by construction, and a
 * contract change reaches the reference set the same day it reaches the tests.
 */
const CONTRACT_VERSION = fixture.contractVersion

/** Fixture rows carry `index`; the rail wants a title and a record slot too.
 *  Trace-only rows are enough for geometry and exercise the real label path. */
const railRows = (rows: readonly { index: number }[]): { index: number }[] =>
  rows.map((r) => ({ index: r.index, record: null, traceTitle: `checkpoint ${r.index}` })) as never

/**
 * The CONTIGUOUS ledger — array position i holds T(i+1), so render space and
 * turn-number space AGREE. The fixture's own words: "which is exactly why the
 * v1 bug went unnoticed." Fine for the ordinary states, useless as a regression
 * guard — which is what `?colocated=1` exists for.
 */
const contiguousRows = railRows(fixture.contiguous.rows)

/**
 * The NON-CONTIGUOUS co-located case — rows 1, 2, 4, 7.
 *
 * The shape the reference set was blind to. Here render-position space and
 * turn-number space DIVERGE: checkpoint 4 sits at array position 2 of 4, so R17
 * anchors it at 0.5 while a v1 turn-number reading lands near 4/7. A reference
 * captured only on contiguous rows cannot tell those apart, and would pass a
 * regression to v1 anchoring straight through — the exact bug c0e6d5f fixed.
 *
 * The boundary's checkpoint is DERIVED, never hardcoded. A trace boundary
 * anchors at the edge BELOW its checkpoint, so co-location needs the checkpoint
 * whose traceFraction equals the pin's pinFraction — computed with the same two
 * functions the rail lays itself out with. If either rule moves, this state
 * stops resolving and throws, instead of quietly photographing three marks that
 * no longer share a Y.
 */
const coRows = railRows(fixture.coLocated.rows)
const coCheckpoint = fixture.coLocated.checkpoint
const coPinFrac = pinFraction(coCheckpoint, coRows as never)
const coTraceAfter = fixture.coLocated.rows
  .map((r) => r.index)
  .find((index) => traceFraction(index, coRows as never) === coPinFrac)

// State comes from the URL so the reference generator can request a state
// deterministically instead of driving interaction for the ones that are not
// interactions (empty ledger, co-location).
const q = new URLSearchParams(location.search)
const EMPTY = q.get('empty') === '1'
const COLOCATED = q.get('colocated') === '1'
// Thumb position as a PROP, not a drag. The reference for co-location needs the
// thumb away from the pin AND the pins undimmed — but holding a drag to move it
// triggers `.cr-ckpt-rail.dragging .cr-ckpt-pin { opacity: .55 }`, and releasing
// snaps the thumb back onto the pin. Driving markerFrac gets both.
const THUMB = q.has('thumb') ? Number(q.get('thumb')) : 0.4

if (COLOCATED && (coPinFrac === null || coTraceAfter === undefined)) {
  // Refuse rather than render a state that merely LOOKS co-located. A reference
  // whose premise silently failed is worse than no reference at all.
  throw new Error(
    `co-located fixture case does not resolve: pinFrac=${coPinFrac}, traceAfter=${coTraceAfter}`
  )
}

const rows = COLOCATED ? coRows : contiguousRows
const pins = EMPTY
  ? []
  : COLOCATED
    ? [
        {
          version: 2,
          atIndex: coCheckpoint,
          scrollLine: 40,
          cutAt: fixture.contiguous.pins[1].cutAt,
          manifestId: fixture.contiguous.pins[1].manifestId
        }
      ]
    : fixture.contiguous.pins
// On contiguous rows a compact boundary AFTER T4 lands at (3+1)/10 = 0.4 — the
// same fraction as pin v2 (T5 at position 4 of 10). COLOCATED swaps in the
// derived boundary so the same coincidence holds on non-contiguous rows.
const markers = [{ kind: 'compact', afterIndex: COLOCATED ? coTraceAfter : 4 }] as never[]
/** Co-located states focus the checkpoint the pin names, so the F6 pair (thumb
 *  + focused tag) is measured on the very checkpoint the marks converge on. */
const activeIndex = COLOCATED ? coCheckpoint : 5

// Published for the generator, so measurements.json records the contract and
// the row shape it ACTUALLY rendered rather than the one a comment claimed.
;(window as never as Record<string, unknown>).__fixture = {
  contractVersion: CONTRACT_VERSION,
  case: COLOCATED ? 'coLocated (non-contiguous rows)' : EMPTY ? 'empty' : 'contiguous',
  rowIndices: (rows as { index: number }[]).map((r) => r.index),
  pinFrac: COLOCATED ? coPinFrac : null,
  traceAfterIndex: COLOCATED ? coTraceAfter : 4
}

const host = document.getElementById('root')!
createRoot(host).render(
  React.createElement(CheckpointTimeline as never, {
    terminalId: 't1',
    rows,
    markers,
    pins,
    titleMode: 'conclusion',
    activeIndex,
    markerFrac: THUMB,
    // Recorded, not swallowed: Tinker's pin-tap-probe reads these to prove a
    // real press reaches the handler. A no-op here made the probe unable to
    // tell "tappable" from "silently ignored".
    onGoto: (i: number) => { (window as never as Record<string, unknown>).__goto = i },
    onLive: () => {},
    onScrub: (f: number) => { (window as never as Record<string, unknown>).__scrub = f }
  })
)
