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

/** The renderer's FORMER arithmetic, kept as the reference the shared function
 *  must still match. It is no longer a transcription of live code — it is the
 *  behaviour the rail had when the gates were green, held here so that removing
 *  the duplication cannot quietly change what the rail draws. */
function rendererTickFraction(afterIndex: number, rows: readonly RailRow[]): number | null {
  const at = rows.findIndex((r) => r.index === afterIndex)
  if (at < 0) return null
  return (at + 1) / rows.length
}

describe('MED-2 — the rail tick and traceFraction are one formula', () => {
  /*
   * THE DUPLICATION IS GONE, so the two assertions that guarded it are gone
   * with it. They required the renderer to CONTAIN `(at + 1) / rows.length`
   * and `if (at < 0) return null`; the rail now calls traceFraction and holds
   * neither string, which is the outcome this guard was written to wait for.
   *
   * What replaces them is deliberately smaller. Tinker's own note on my slice
   * applies here: a source-text regex is a PROXY for behaviour, and the moment
   * the behaviour has a real home — one shared function with an equivalence
   * table under it, and a rendered probe over it — the proxy should shrink to
   * the one thing source text can honestly assert, which is that the call site
   * exists at all. Everything about what it COMPUTES is checked below against
   * the function, and what it DRAWS is checked by the reference rig
   * (scratchpad/f6-reference) against the rendered rail.
   */
  it('the renderer calls the shared anchor instead of keeping a copy', () => {
    const normalised = source.replace(/\s+/g, ' ')
    expect(normalised).toContain('traceFraction(m.afterIndex, rows)')
    expect(normalised).not.toContain('const frac = (at + 1) / rows.length')
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
