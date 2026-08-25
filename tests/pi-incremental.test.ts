// Sol r3 P1 (Pi observation O(total) per delta): I3 promises observation
// cost independent of history size, not merely O(Δ) disk reads. The Pi
// accumulator now feeds appended entries straight into a retained block
// builder when they extend the current active branch (the token-rate common
// case); only a BRANCH SWITCH — a context entry whose parent is not the
// current leaf — pays the full branch rebuild, and that exception is
// explicit and counted. The stats() ops-counter is the measured gate: do
// not delete it to land a change; a regression to O(N)-per-append shows up
// here as an entriesWalked delta proportional to the tree.

import { describe, expect, it } from 'vitest'
import { createPiTraceAccumulator, parsePiTrace } from '../src/shared/trace-blocks'

const T0 = Date.parse('2026-08-05T10:00:00.000Z')

function userLine(id: string, parentId: string | null, text: string, at: number): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    message: { role: 'user', content: text, timestamp: at }
  })
}

function assistantLine(id: string, parentId: string, text: string, at: number): string {
  return JSON.stringify({
    type: 'message',
    id,
    parentId,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      timestamp: at,
      stopReason: 'stop'
    }
  })
}

/** A linear N-turn pi tree: u1→a1→u2→a2→… */
function linearTree(turns: number): string[] {
  const lines: string[] = []
  let parent: string | null = null
  for (let i = 1; i <= turns; i += 1) {
    lines.push(userLine(`u${i}`, parent, `ask ${i}`, T0 + i * 1000))
    lines.push(assistantLine(`a${i}`, `u${i}`, `answer ${i}`, T0 + i * 1000 + 500))
    parent = `a${i}`
  }
  return lines
}

describe('pi incremental observation (the parse-work gate)', () => {
  it('appending one turn to an N-turn tree does work bounded by the suffix, not N', () => {
    const N = 300
    const acc = createPiTraceAccumulator()
    acc.feed(linearTree(N))
    expect(acc.blocks()).toHaveLength(N)
    const before = acc.stats()

    // One appended turn: two entries. The whole point of the fix.
    acc.feed([
      userLine(`u${N + 1}`, `a${N}`, 'one more', T0 + (N + 1) * 1000),
      assistantLine(`a${N + 1}`, `u${N + 1}`, 'done', T0 + (N + 1) * 1000 + 500)
    ])
    const after = acc.stats()

    expect(acc.blocks()).toHaveLength(N + 1)
    // Suffix-bounded: exactly the appended entries were walked — not the tree.
    expect(after.entriesWalked - before.entriesWalked).toBe(2)
    expect(after.fullRebuilds).toBe(before.fullRebuilds)
  })

  it('the linear whole-file feed itself never pays a rebuild', () => {
    const acc = createPiTraceAccumulator()
    acc.feed(linearTree(50))
    expect(acc.stats().fullRebuilds).toBe(0)
    expect(acc.stats().entriesWalked).toBe(100)
  })

  it('a branch switch pays ONE full rebuild — the documented exception — and stays exact', () => {
    const N = 20
    const lines = linearTree(N)
    const acc = createPiTraceAccumulator()
    acc.feed(lines)
    const before = acc.stats()

    // /tree back to turn 5 and continue from there: the new prompt's parent
    // is an OLDER node, re-rooting the visible conversation.
    const switchLines = [
      userLine('u-branch', 'a5', 'take the other path', T0 + 99_000),
      assistantLine('a-branch', 'u-branch', 'other path taken', T0 + 99_500)
    ]
    acc.feed(switchLines)
    const after = acc.stats()
    expect(after.fullRebuilds).toBe(before.fullRebuilds + 1)

    // Exactness is non-negotiable: the incremental view equals a whole-file
    // parse of the same lines.
    const whole = parsePiTrace([...lines, ...switchLines])
    expect(acc.blocks()).toEqual(whole)
    expect(acc.blocks().map((b) => b.id)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5', 'u-branch'])

    // …and appends AFTER the switch are back on the cheap path.
    acc.feed([
      userLine('u-next', 'a-branch', 'continue here', T0 + 100_000),
      assistantLine('a-next', 'u-next', 'continuing', T0 + 100_500)
    ])
    const resumed = acc.stats()
    expect(resumed.fullRebuilds).toBe(after.fullRebuilds)
    expect(resumed.entriesWalked - after.entriesWalked).toBe(2)
  })

  it('chunked feeding with an abandoned sibling branch matches the whole-file parse', () => {
    // The trace-blocks fixture shape: a dead branch is briefly the active
    // one (it holds the last leaf), then the real continuation re-roots.
    const lines = [
      JSON.stringify({ type: 'session', version: 3, id: 's', cwd: '/w' }),
      userLine('u1', null, 'Inspect it', T0),
      assistantLine('a1', 'u1', 'Checking.', T0 + 1000),
      userLine('dead-u', 'a1', 'Abandoned branch', T0 + 2000),
      assistantLine('dead-a', 'dead-u', 'Old answer', T0 + 3000),
      userLine('u2', 'a1', 'Fix it', T0 + 4000),
      assistantLine('a2', 'u2', 'Done.', T0 + 5000)
    ]
    for (let split = 1; split < lines.length; split += 1) {
      const acc = createPiTraceAccumulator()
      acc.feed(lines.slice(0, split))
      acc.feed(lines.slice(split))
      expect(acc.blocks(), `split at ${split}`).toEqual(parsePiTrace(lines))
    }
    expect(parsePiTrace(lines).map((b) => b.id)).toEqual(['u1', 'u2'])
  })

  it('mid-branch intermediate reads reflect the branch active AT THAT MOMENT', () => {
    // While the dead branch holds the last leaf it IS the active branch —
    // the incremental view must say so, exactly like a fresh full parse.
    const head = [
      userLine('u1', null, 'Inspect it', T0),
      assistantLine('a1', 'u1', 'Checking.', T0 + 1000),
      userLine('dead-u', 'a1', 'Abandoned branch', T0 + 2000)
    ]
    const acc = createPiTraceAccumulator()
    acc.feed(head)
    expect(acc.blocks().map((b) => b.id)).toEqual(parsePiTrace(head).map((b) => b.id))
    expect(acc.blocks().map((b) => b.id)).toEqual(['u1', 'dead-u'])
  })
})
