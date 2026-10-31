// A COLD-RESUMED AGENT SWALLOWS THE FIRST CARRIAGE RETURNS.
//
// Measured 2026-10-31: after closing Harden, `cookrew ask "Harden" …` respawned
// it on the SAME claude session (correct — context intact, new pane), typed the
// prompt into the box, sent its CR retries, and reported `unsubmitted`: the TUI
// was still painting the resumed transcript, so every CR was swallowed. A CR
// sent once the pane went quiet submitted the turn immediately (11 → 12 turns).
//
// Two defects, both pinned here:
//   - the ask path delivered into a pane that had not finished booting;
//   - the remedy the product itself prints ("send a carriage return") had no
//     escape: decodeRawEscapes maps \n to CR but typed a literal `\r`.
import { describe, expect, it } from 'vitest'
import { decodeRawEscapes, waitForReady } from '../src/main/ask'

function fakeSession(texts: string[]) {
  let i = 0
  return {
    fullText: () => texts[Math.min(i++, texts.length - 1)],
    /** How many times the pane was sampled — a wait that never samples is broken. */
    samples: () => i
  }
}

describe('decodeRawEscapes — the remedy the product prints', () => {
  it('maps \\r to a real carriage return', () => {
    expect(decodeRawEscapes('\\r')).toBe('\r')
  })

  it('keeps it mid-string', () => {
    expect(decodeRawEscapes('a\\rb')).toBe('a\rb')
  })

  it('still maps \\n to Enter', () => {
    expect(decodeRawEscapes('\\n')).toBe('\r')
  })

  it('still decodes hex and ESC', () => {
    expect(decodeRawEscapes('\\x1b[A')).toBe('\x1b[A')
  })
})

describe('waitForReady — a pane that is still painting is not ready', () => {
  it('waits for the pane to go quiet and says when it did', async () => {
    const growing = fakeSession(['a', 'ab', 'abc', 'abc', 'abc', 'abc'])
    const ready = await waitForReady(growing, { quietMs: 60, pollMs: 20, minMs: 0, timeoutMs: 2000 })
    expect(ready).toBe(true)
    expect(growing.samples()).toBeGreaterThan(3)
  })

  it('gives up at the deadline instead of waiting forever', async () => {
    const forever = fakeSession(Array.from({ length: 1000 }, (_, i) => 'x'.repeat(i + 1)))
    const started = Date.now()
    const ready = await waitForReady(forever, { quietMs: 1000, pollMs: 20, minMs: 0, timeoutMs: 300 })
    expect(ready).toBe(false)
    expect(Date.now() - started).toBeLessThan(1500)
  })

  it('honours a minimum boot window even when the text is already stable', async () => {
    const still = fakeSession(['ready'])
    const started = Date.now()
    await waitForReady(still, { quietMs: 30, pollMs: 10, minMs: 150, timeoutMs: 2000 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(140)
  })
})
