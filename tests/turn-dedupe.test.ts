import { describe, expect, it } from 'vitest'
import { dedupePhantomEchoes } from '../src/shared/turn'
import type { TurnRecord } from '../src/shared/turn'

const rec = (over: Partial<TurnRecord> & { index: number; prompt: string }): TurnRecord => ({
  reply: 'r',
  startedAt: 1,
  endedAt: 2,
  ...over
})

describe('dedupePhantomEchoes', () => {
  it('drops a uuid-less record duplicating the PREVIOUS uuid record (Conductor T71/72)', () => {
    const out = dedupePhantomEchoes([
      rec({ index: 71, prompt: 'Magpie — RESEARCH + EVALUATION REPORT:', uuid: 'u71' }),
      rec({ index: 72, prompt: 'Magpie — RESEARCH + EVALUATION REPORT:' })
    ])
    expect(out.map((r) => r.index)).toEqual([71])
    expect(out[0].uuid).toBe('u71')
  })

  it('drops a uuid-less record duplicating the NEXT uuid record', () => {
    const out = dedupePhantomEchoes([
      rec({ index: 5, prompt: 'push' }),
      rec({ index: 6, prompt: 'push', uuid: 'u6' })
    ])
    expect(out.map((r) => r.index)).toEqual([6])
  })

  it('keeps genuine repeats where BOTH records carry a uuid (T36/T38 Push class)', () => {
    const out = dedupePhantomEchoes([
      rec({ index: 36, prompt: 'Push', uuid: 'u36' }),
      rec({ index: 37, prompt: 'unrelated', uuid: 'u37' }),
      rec({ index: 38, prompt: 'Push', uuid: 'u38' })
    ])
    expect(out.map((r) => r.index)).toEqual([36, 37, 38])
  })

  it('keeps a uuid-less record whose prompt differs from its uuid neighbours', () => {
    const out = dedupePhantomEchoes([
      rec({ index: 1, prompt: 'alpha', uuid: 'u1' }),
      rec({ index: 2, prompt: 'beta' }),
      rec({ index: 3, prompt: 'gamma', uuid: 'u3' })
    ])
    expect(out.map((r) => r.index)).toEqual([1, 2, 3])
  })

  it('does not treat NON-adjacent same-prompt uuid records as phantoms', () => {
    const out = dedupePhantomEchoes([
      rec({ index: 33, prompt: 'Review and commit and restart', uuid: 'u33' }),
      rec({ index: 34, prompt: 'task-a', uuid: 'u34' }),
      rec({ index: 37, prompt: 'Review and commit and restart', uuid: 'u37' })
    ])
    expect(out).toHaveLength(3)
  })

  it('leaves an all-uuid-less history untouched (Codex / no session file)', () => {
    const codex = [
      rec({ index: 1, prompt: 'build' }),
      rec({ index: 2, prompt: 'build' })
    ]
    expect(dedupePhantomEchoes(codex)).toBe(codex)
  })

  it('carries the phantom title/seenAt onto the surviving uuid record when it lacks them', () => {
    const out = dedupePhantomEchoes([
      rec({ index: 71, prompt: 'push', uuid: 'u71' }),
      rec({ index: 72, prompt: 'push', title: 'Pushing to main', seenAt: 999 })
    ])
    expect(out).toHaveLength(1)
    expect(out[0].title).toBe('Pushing to main')
    expect(out[0].seenAt).toBe(999)
  })

  it('does not overwrite an existing title on the survivor', () => {
    const out = dedupePhantomEchoes([
      rec({ index: 71, prompt: 'push', uuid: 'u71', title: 'Kept' }),
      rec({ index: 72, prompt: 'push', title: 'Phantom' })
    ])
    expect(out[0].title).toBe('Kept')
  })
})
