import { createRoot } from 'react-dom/client'
import React from 'react'
import { CheckpointTimeline } from '../../src/renderer/src/CheckpointTimeline'
import '../../src/renderer/src/styles.css'
import '../../src/renderer/src/agent-roster.css'

// contiguous case from tests/fixtures/version-pins.json (contract v2)
// CheckpointRow = { index, record, traceTitle } — trace-only rows are enough
// for geometry, and they exercise the label path the rail actually uses.
const rows = Array.from({ length: 10 }, (_, i) => ({
  index: i + 1, record: null, traceTitle: `checkpoint ${i + 1}`
})) as never[]
const pins = [
  { version: 1, atIndex: 1, scrollLine: 10, cutAt: 1 },
  { version: 2, atIndex: 5, scrollLine: 50, cutAt: 2 },
  { version: 12, atIndex: 8, scrollLine: 80, cutAt: 3 },
  { version: 100, atIndex: 10, scrollLine: 100, cutAt: 4 }
]
// a compact boundary AFTER T4 lands at (3+1)/10 = 0.4 — the same fraction as
// pin v2 (T5 at position 4 of 10). That is the co-located case, for real.
const markers = [{ kind: 'compact', afterIndex: 4 }] as never[]

// State comes from the URL so the reference generator can request a state
// deterministically instead of driving interaction for the ones that are not
// interactions (empty ledger, light chrome).
const q = new URLSearchParams(location.search)
const EMPTY = q.get('empty') === '1'
// Thumb position as a PROP, not a drag. The reference for co-location needs the
// thumb away from the pin AND the pins undimmed — but holding a drag to move it
// triggers `.cr-ckpt-rail.dragging .cr-ckpt-pin { opacity: .55 }`, and releasing
// snaps the thumb back onto the pin. Driving markerFrac gets both.
const THUMB = q.has('thumb') ? Number(q.get('thumb')) : 0.4
// .on-cream lives on .cr-ckpt-rail, which the component owns, so it is applied
// after mount rather than guessed onto a parent.

const host = document.getElementById('root')!
createRoot(host).render(
  React.createElement(CheckpointTimeline as never, {
    terminalId: 't1', rows, markers, pins: EMPTY ? [] : pins, titleMode: 'conclusion',
    activeIndex: 5, markerFrac: THUMB,
    // Recorded, not swallowed: Tinker's pin-tap-probe reads these to prove a
    // real press reaches the handler. A no-op here made the probe unable to
    // tell "tappable" from "silently ignored".
    onGoto: (i: number) => { (window as never as Record<string, unknown>).__goto = i },
    onLive: () => {},
    onScrub: (f: number) => { (window as never as Record<string, unknown>).__scrub = f }
  })
)
