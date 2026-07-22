import { describe, expect, it } from 'vitest'
import { parseSessionTurns } from '../src/shared/session-turns'
import { parseClaudeTrace } from '../src/shared/trace-blocks'
import { mergeCheckpointRows } from '../src/renderer/src/transcript'
import type { TurnRecord } from '../src/shared/turn'

// ROOT-CAUSE HIGH: trace-block.index and TurnRecord.index were two independent
// coordinate systems (positional trace counter vs reconciled turn count).
// After unification via the shared CheckpointAssigner they must agree per
// uuid on EVERY session shape, so records-union-trace pairs correctly.

const T = (s: string): string => `2026-07-22T10:${s}:00.000Z`
const user = (content: unknown, ts: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ type: 'user', message: { role: 'user', content }, timestamp: ts, ...extra })
const assistant = (text: string, ts: string): string =>
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timestamp: ts
  })
const imagePrompt = (text: string): unknown[] => [
  { type: 'text', text },
  { type: 'image', source: { type: 'base64', data: 'x' } }
]

/** A session mixing plain, sibling-collapsed, and image prompts — the exact
 *  divergence generators (Velvet's +2 phantom offset was skipped images). */
function divergentSession(): string[] {
  return [
    user('first plain ask', T('00'), { uuid: 'u1', parentUuid: 'p1' }),
    assistant('reply one', T('01')),
    // Sibling collapse: Claude's string mirror + text/image record, one submission.
    user('second ask', T('02'), { uuid: 'u2a', parentUuid: 'p2' }),
    user(imagePrompt('second ask'), T('02'), { uuid: 'u2b', parentUuid: 'p2' }),
    assistant('reply two', T('03')),
    // Image-only submission — old trace parser SKIPPED these (string-only), the
    // exact source of the +2 phantom offset vs the reconciled record count.
    user(imagePrompt('describe this screenshot'), T('04'), { uuid: 'u3', parentUuid: 'p3' }),
    assistant('reply three', T('05'))
  ]
}

describe('unified checkpoint identity (parseSessionTurns ≡ parseClaudeTrace)', () => {
  it('assigns the SAME index per uuid across plain, sibling, and image prompts', () => {
    const lines = divergentSession()
    const records = parseSessionTurns(lines)
    const blocks = parseClaudeTrace(lines)

    // Both collapse the sibling pair and count the image prompt: 3 checkpoints.
    expect(records.map((r) => r.index)).toEqual([1, 2, 3])
    expect(blocks.map((b) => b.index)).toEqual([1, 2, 3])

    // uuid → index agrees on both sides (the structural guarantee).
    const recordByUuid = new Map(records.map((r) => [r.uuid, r.index]))
    for (const block of blocks) {
      expect(recordByUuid.get(block.id)).toBe(block.index)
    }
    // Sibling collapsed to the CONTINUATION uuid (u2b), not the mirror (u2a).
    expect(blocks[1].id).toBe('u2b')
    expect(records[1].uuid).toBe('u2b')
  })

  it('no phantom offset: trace ceiling == record latest index', () => {
    const lines = divergentSession()
    const records = parseSessionTurns(lines)
    const blocks = parseClaudeTrace(lines)
    const ceiling = blocks[blocks.length - 1].index
    const recordLatest = records[records.length - 1].index
    expect(ceiling).toBe(recordLatest) // was 38 vs 40 (Velvet +2) before the fix
  })
})

describe('mergeCheckpointRows over the divergence shapes', () => {
  const traceIndex = [1, 2, 3, 4, 5].map((index) => ({ index, title: `T${index}` }))

  it('capped agent (Conductor -18 class): sub-cap identities render trace-only, real numbers', () => {
    // Record store starts at T3 (older dropped); trace still spans T1..T5.
    const records: TurnRecord[] = [3, 4, 5].map((index) => ({
      index,
      prompt: `p${index}`,
      reply: `r${index}`,
      uuid: `u${index}`,
      startedAt: index,
      endedAt: index
    }))
    const rows = mergeCheckpointRows(records, traceIndex)
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3, 4, 5])
    // T1, T2 are trace-only (no record) but carry REAL identities + titles.
    expect(rows[0]).toMatchObject({ index: 1, record: null, traceTitle: 'T1' })
    expect(rows[2].record?.uuid).toBe('u3') // paired to the RIGHT record
    expect(rows[4].record?.uuid).toBe('u5')
  })

  it('aligned agent (Tinker class): every record pairs its own trace row, no phantoms', () => {
    const records: TurnRecord[] = [1, 2, 3, 4, 5].map((index) => ({
      index,
      prompt: `p${index}`,
      reply: '',
      uuid: `u${index}`,
      startedAt: index,
      endedAt: index
    }))
    const rows = mergeCheckpointRows(records, traceIndex)
    expect(rows).toHaveLength(5) // no rows past the ceiling
    expect(rows.every((r) => r.record !== null)).toBe(true)
  })
})
