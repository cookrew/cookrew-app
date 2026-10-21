import { describe, expect, it } from 'vitest'
import type { LevelsAgentDetail } from '../src/shared/strata'
import { syntheticFleet } from '../src/strata/fixture/synthetic'
import { createDetailLoader } from '../src/renderer/src/embed/detail-loader'
import type { DetailResult } from '../src/renderer/src/embed/embed-boot'

const agents = syntheticFleet(1_800_000_000_000)[0].levels!.workspaces[0].agents
const detailOf = (i: number): LevelsAgentDetail => ({ agent: agents[i], workspaceId: 'w', notes: [], browsers: [] })

/** A fetch whose answers the test releases by hand, recording every start and abort. */
const fakeFetch = () => {
  const calls: Array<{ id: string; signal: AbortSignal; answer: () => void }> = []
  const fetchDetail = (id: string, signal: AbortSignal) =>
    new Promise<DetailResult>((resolve) => {
      const i = agents.findIndex((a) => a.id === id)
      signal.addEventListener('abort', () => resolve({ ok: false, code: 'unreachable', detail: 'aborted' }))
      calls.push({ id, signal, answer: () => resolve({ ok: true, detail: detailOf(i) }) })
    })
  return { calls, fetchDetail }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('embed detail prefetch', () => {
  it('keeps one read in flight per document, and the latest hover wins', async () => {
    const { calls, fetchDetail } = fakeFetch()
    const loader = createDetailLoader(fetchDetail)
    loader.prefetch(agents[0].id)
    loader.prefetch(agents[1].id)
    loader.prefetch(agents[2].id)
    expect(calls.map((c) => c.signal.aborted)).toEqual([true, true, false])
    expect(loader.inFlight()).toBe(agents[2].id)
    calls[2].answer()
    await flush()
    expect(loader.known(agents[2].id)?.agent.id).toBe(agents[2].id)
    expect(loader.known(agents[0].id)).toBeNull()
    expect(loader.inFlight()).toBeNull()
  })

  it('a dive joins the read its hover started instead of asking twice', async () => {
    const { calls, fetchDetail } = fakeFetch()
    const loader = createDetailLoader(fetchDetail)
    loader.prefetch(agents[3].id)
    const dive = loader.load(agents[3].id)
    expect(calls).toHaveLength(1)
    calls[0].answer()
    expect((await dive).ok).toBe(true)
  })

  it('a hover never aborts the read a dive is waiting on', async () => {
    const { calls, fetchDetail } = fakeFetch()
    const loader = createDetailLoader(fetchDetail)
    const dive = loader.load(agents[4].id)
    loader.prefetch(agents[5].id)
    expect(calls).toHaveLength(1)
    expect(calls[0].signal.aborted).toBe(false)
    calls[0].answer()
    expect((await dive).ok).toBe(true)
  })

  it('a dive to another agent aborts a hover’s read; a known agent is not read ahead again', async () => {
    const { calls, fetchDetail } = fakeFetch()
    const loader = createDetailLoader(fetchDetail)
    loader.prefetch(agents[6].id)
    const dive = loader.load(agents[7].id)
    expect(calls[0].signal.aborted).toBe(true)
    calls[1].answer()
    await dive
    loader.prefetch(agents[7].id)
    expect(calls).toHaveLength(2)
  })
})
