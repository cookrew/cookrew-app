import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceBlock } from '../src/shared/trace-blocks'

// Restored guard (integration round 2): the transcript adapter must call the
// REAL trace path — listTrace — with IDENTITY anchors passed through
// untouched (review BLOCKs 1+2), and blocks must carry the tool-activity
// lines the view renders. No fetch-all fallback exists.
const mockApi: Record<string, unknown> = {}
vi.mock('../src/renderer/src/api', () => ({ cookrew: () => mockApi }))

import { fetchTracePage, hasTraceApi } from '../src/renderer/src/transcript'

function traceBlock(index: number): TraceBlock {
  return {
    id: `u${index}`,
    index,
    prompt: `ask ${index}`,
    reply: `reply ${index}`,
    activity: [`Bash(step ${index})`],
    startedAt: index,
    endedAt: index + 1
  }
}

describe('fetchTracePage guard (review BLOCK 1 + 2, trace-sourced)', () => {
  beforeEach(() => {
    delete mockApi.listTrace
  })

  it('calls listTrace — the REAL trace path — with identity anchors untouched', async () => {
    const listTrace = vi.fn(async () => ({
      blocks: [traceBlock(4), traceBlock(5)],
      total: 9,
      source: 'claude' as const
    }))
    mockApi.listTrace = listTrace

    const page = await fetchTracePage('t1', { beforeIndex: 6, limit: 2 })
    expect(listTrace).toHaveBeenCalledWith('t1', { beforeIndex: 6, limit: 2 })
    expect(page.blocks.map((b) => b.index)).toEqual([4, 5])
    expect(page.blocks[0].activity).toEqual(['Bash(step 4)']) // view renders these
    expect(page.source).toBe('claude')

    await fetchTracePage('t1', { aroundIndex: 5, limit: 3 })
    expect(listTrace).toHaveBeenLastCalledWith('t1', { aroundIndex: 5, limit: 3 })

    await fetchTracePage('t1', { limit: 20 })
    expect(listTrace).toHaveBeenLastCalledWith('t1', { limit: 20 }) // tail, no offsets
  })

  it('has NO fetch-all fallback — absent backend yields an empty page', async () => {
    expect(hasTraceApi()).toBe(false)
    expect(await fetchTracePage('t1', { limit: 5 })).toEqual({
      blocks: [],
      total: 0,
      source: null
    })
  })
})
