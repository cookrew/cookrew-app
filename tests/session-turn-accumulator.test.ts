// Fix 2 (Sol I3): the resumable accumulator must be indistinguishable from
// whole-file parsing for ANY split of the input lines — including splits
// mid-turn — and reading records mid-stream must not disturb later feeds.
// parseSessionTurns is itself a single-feed use of the accumulator, so this
// suite is the equivalence proof the O(Δbytes) reconcile path stands on.

import { describe, expect, it } from 'vitest'
import {
  createSessionTurnAccumulator,
  parseSessionTurns
} from '../src/shared/session-turns'

const T = (m: number, s: number): string =>
  `2026-07-20T10:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000Z`

function user(content: unknown, ts: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content }, timestamp: ts, ...extra })
}

function assistant(blocks: unknown[], ts: string, stopReason: string | null): string {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: blocks, stop_reason: stopReason },
    timestamp: ts
  })
}

const text = (t: string): { type: string; text: string } => ({ type: 'text', text: t })
const toolUse = (): { type: string; name: string } => ({ type: 'tool_use', name: 'Bash' })
const toolResult = (): unknown[] => [{ type: 'tool_result', content: 'ok' }]

/** A realistic multi-turn session: tools, siblings, noise, junk, unicode. */
function sessionLines(): string[] {
  const lines: string[] = []
  for (let turn = 0; turn < 12; turn += 1) {
    lines.push(user(`prompt ${turn} — fixé l'été 目标`, T(turn, 0), { uuid: `u-${turn}`, parentUuid: `p-${turn}` }))
    if (turn % 4 === 1) {
      // Sibling resend (same parentUuid) — the collapse case, split-sensitive.
      lines.push(user(`prompt ${turn} refined`, T(turn, 1), { uuid: `u-${turn}b`, parentUuid: `p-${turn}` }))
    }
    lines.push(assistant([text(`working on ${turn}…`)], T(turn, 5), 'tool_use'))
    lines.push(assistant([toolUse()], T(turn, 10), 'tool_use'))
    lines.push(user(toolResult(), T(turn, 12)))
    if (turn % 3 === 0) lines.push('this line is not json')
    if (turn % 5 === 0) lines.push('')
    lines.push(
      assistant([text(`done ${turn} ✓`)], T(turn, 20), turn === 11 ? 'tool_use' : 'end_turn')
    )
  }
  return lines
}

/** Deterministic LCG so a failing split is reproducible from its seed. */
function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function chunked<T>(items: T[], rand: () => number): T[][] {
  const chunks: T[][] = []
  let at = 0
  while (at < items.length) {
    const size = 1 + Math.floor(rand() * 5)
    chunks.push(items.slice(at, at + size))
    at += size
  }
  return chunks
}

describe('createSessionTurnAccumulator — split equivalence', () => {
  it('produces identical records for randomized chunk boundaries (30 seeded trials)', () => {
    const lines = sessionLines()
    const whole = parseSessionTurns(lines)
    for (let seed = 1; seed <= 30; seed += 1) {
      const accumulator = createSessionTurnAccumulator()
      for (const chunk of chunked(lines, lcg(seed))) accumulator.feed(chunk)
      expect(accumulator.records(), `seed ${seed}`).toEqual(whole)
    }
  })

  it('matches the whole-file parse at EVERY prefix, one line per feed', () => {
    const lines = sessionLines()
    const accumulator = createSessionTurnAccumulator()
    for (let i = 0; i < lines.length; i += 1) {
      accumulator.feed([lines[i]])
      expect(accumulator.records(), `prefix ${i + 1}`).toEqual(
        parseSessionTurns(lines.slice(0, i + 1))
      )
    }
  })

  it('reading records mid-stream returns a copy — later feeds do not mutate it', () => {
    const lines = sessionLines()
    const accumulator = createSessionTurnAccumulator()
    accumulator.feed(lines.slice(0, 4))
    const early = accumulator.records()
    const snapshot = JSON.parse(JSON.stringify(early)) as unknown
    accumulator.feed(lines.slice(4))
    expect(early).toEqual(snapshot)
  })

  it('a feed split INSIDE a turn (prompt in one chunk, reply in the next) still finalizes on evidence', () => {
    const accumulator = createSessionTurnAccumulator()
    accumulator.feed([user('do it', T(0, 0), { uuid: 'u1' })])
    expect(accumulator.records()[0].final).toBeUndefined()
    accumulator.feed([assistant([text('done')], T(0, 20), 'end_turn')])
    expect(accumulator.records()[0].final).toBe(true)
  })
})
