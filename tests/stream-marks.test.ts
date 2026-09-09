// The one join: the stream's index, marks attached by identity, in one place.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeMark } from '../src/main/marks'
import { createCheckpointReader } from '../src/main/stream-marks'
import type { StreamIndexResult } from '../src/main/stream'

const entry = (identity: string, ordinal: number): StreamIndexResult['entries'][number] => ({
  identity,
  ordinal,
  startedAt: ordinal * 1000,
  endedAt: ordinal * 1000 + 5,
  promptHead: `ask ${ordinal}`,
  compacted: false,
  file: 's1.jsonl'
})

const index = (result: Partial<StreamIndexResult>) => async (): Promise<StreamIndexResult> => ({
  entries: result.entries ?? [],
  missing: result.missing ?? []
})

describe('checkpoints(terminalId)', () => {
  it('attaches a mark to its block and leaves the rest plain', async () => {
    const reader = createCheckpointReader({
      index: index({ entries: [entry('u1', 1), entry('u2', 2)] }),
      marksOf: () =>
        new Map([['u2', { identity: 'u2', at: 9, title: 'ran the suite', seenAt: 10 }]])
    })
    const { checkpoints, orphanMarks } = await reader.checkpoints('t1')
    expect(orphanMarks).toEqual([])
    expect(checkpoints[0]).toEqual(entry('u1', 1))
    expect(checkpoints[1]).toMatchObject({ ordinal: 2, title: 'ran the suite', seenAt: 10 })
  })

  it('a mark can never shadow the stream — no identity or at leaks into a row', async () => {
    const reader = createCheckpointReader({
      index: index({ entries: [entry('u1', 1)] }),
      marksOf: () => new Map([['u1', { identity: 'SPOOF', at: 12345, pin: 4 }]])
    })
    const [row] = (await reader.checkpoints('t1')).checkpoints
    expect(row.identity).toBe('u1')
    expect(row).not.toHaveProperty('at')
    expect(row.pin).toBe(4)
  })

  it('reports an orphan mark instead of dropping it', async () => {
    const reader = createCheckpointReader({
      index: index({
        entries: [entry('u1', 1)],
        missing: [{ sessionId: 'gone', file: 'gone.jsonl', reason: 'no-transcript' }]
      }),
      marksOf: () => new Map([['from-the-lost-file', { identity: 'from-the-lost-file', at: 1 }]])
    })
    const result = await reader.checkpoints('t1')
    expect(result.orphanMarks).toEqual(['from-the-lost-file'])
    expect(result.missing).toHaveLength(1)
  })

  it('an unreadable ledger costs the titles, never the history', async () => {
    const reader = createCheckpointReader({
      index: index({ entries: [entry('u1', 1)] }),
      marksOf: () => {
        throw new Error('ledger on fire')
      }
    })
    const result = await reader.checkpoints('t1')
    expect(result.checkpoints).toHaveLength(1)
    expect(result.checkpoints[0].title).toBeUndefined()
  })

  it('reads the real ledger through readMarks when nothing is injected', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'stream-marks-'))
    const id = 'b1b2c3d4-0000-4000-8000-000000000002'
    writeMark(id, { identity: 'u1', title: 'from disk' }, { dir })
    const reader = createCheckpointReader({
      index: index({ entries: [entry('u1', 1)] }),
      markOptions: { dir }
    })
    const [row] = (await reader.checkpoints(id)).checkpoints
    expect(row.title).toBe('from disk')
  })
})
