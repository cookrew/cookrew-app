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

const host = document.getElementById('root')!
createRoot(host).render(
  React.createElement(CheckpointTimeline as never, {
    terminalId: 't1', rows, markers, pins, titleMode: 'conclusion',
    activeIndex: 5, markerFrac: 0.4,
    onGoto: () => {}, onLive: () => {}, onScrub: () => {}
  })
)
