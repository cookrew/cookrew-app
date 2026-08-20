import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { traceFraction, type RailRow } from '../src/shared/version-pin'

/**
 * MED-2 (Tinker) — the renderer computes its tick fraction INLINE at
 * CheckpointTimeline.tsx rather than calling `traceFraction`. Two copies of one
 * formula is exactly the shape of the bug this branch fixes: R17 drifted
 * because trace markers and the focus tab were placed by two expressions that
 * agreed until a ledger made them disagree.
 *
 * So this is a parity guard, in two halves that catch different things:
 *
 *   1. A SOURCE assertion — the renderer still computes (at + 1) / rows.length
 *      and still omits an undrawn checkpoint. If someone edits that expression,
 *      this fails and they are sent here to read why, instead of discovering it
 *      on a non-contiguous ledger months later.
 *   2. An EQUIVALENCE table — the shared function returns exactly what that
 *      expression produces, across contiguous, non-contiguous, first, last and
 *      undrawn cases.
 *
 * The durable fix is for the rail to import `traceFraction` and delete its
 * copy; that is rail code and therefore Fresco's call, so this guards the
 * duplication rather than removing it.
 */

const source = readFileSync(
  path.join(__dirname, '..', 'src/renderer/src/CheckpointTimeline.tsx'),
  'utf8'
)

/** The renderer's arithmetic, transcribed. Kept beside the source assertion so
 *  the two cannot drift apart silently. */
function rendererTickFraction(afterIndex: number, rows: readonly RailRow[]): number | null {
  const at = rows.findIndex((r) => r.index === afterIndex)
  if (at < 0) return null
  return (at + 1) / rows.length
}

describe('MED-2 — the rail tick and traceFraction are one formula', () => {
  it('the renderer still computes (at + 1) / rows.length', () => {
    // Whitespace-insensitive so formatting alone cannot fail it.
    const normalised = source.replace(/\s+/g, ' ')
    expect(normalised).toContain('const frac = (at + 1) / rows.length')
  })

  it('the renderer still OMITS a checkpoint that is not drawn', () => {
    const normalised = source.replace(/\s+/g, ' ')
    // Clamping instead of omitting is the specific regression R8 forbids: a
    // marker placed on an end of the bar it has no claim to.
    expect(normalised).toContain('if (at < 0) return null')
  })

  it('agrees with traceFraction on a contiguous ledger', () => {
    const rows: RailRow[] = [1, 2, 3, 4, 5].map((index) => ({ index }))
    for (const row of rows) {
      expect(traceFraction(row.index, rows)).toBe(rendererTickFraction(row.index, rows))
    }
  })

  it('agrees on the NON-CONTIGUOUS ledger that motivated the space (R17)', () => {
    const rows: RailRow[] = []
    for (let i = 1; i <= 113; i++) rows.push({ index: i })
    for (const index of [116, 118, 119, 121, 124]) rows.push({ index })
    for (const index of [1, 57, 113, 116, 121, 124]) {
      expect(traceFraction(index, rows)).toBe(rendererTickFraction(index, rows))
    }
  })

  it('agrees at both ends — first row, and the boundary at the bottom', () => {
    const rows: RailRow[] = [{ index: 1 }, { index: 2 }, { index: 4 }, { index: 7 }]
    expect(traceFraction(1, rows)).toBe(rendererTickFraction(1, rows))
    expect(traceFraction(7, rows)).toBe(rendererTickFraction(7, rows))
    // The half of the bug that was invisible until the end of a transcript.
    expect(traceFraction(7, rows)).toBe(1)
  })

  it('agrees that an undrawn checkpoint has no position at all', () => {
    const rows: RailRow[] = [{ index: 1 }, { index: 2 }, { index: 4 }]
    for (const index of [3, 5, 99, -1]) {
      expect(traceFraction(index, rows)).toBeNull()
      expect(rendererTickFraction(index, rows)).toBeNull()
    }
  })

  it('agrees that no rows means no ticks', () => {
    expect(traceFraction(1, [])).toBeNull()
    expect(rendererTickFraction(1, [])).toBeNull()
  })
})
