// A dispatch to a sleeping agent wakes it instead of answering `unreachable`.
// (agent-sleep.ts: an idle agent's process is ended after ten minutes; the
// conversation is on disk and comes back by resume.)
import { describe, expect, it } from 'vitest'
import { DispatchService, type DispatchDeps } from '../src/main/dispatch'

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    resolveAgent: (id) => (id === 'forge' ? { name: 'Forge', workspaceId: 'ws-1' } : null),
    sessionNameFor: (id) => `cookrew_${id}`,
    sessionExists: () => false,
    capture: () => 'idle\n> ',
    promptAgent: async () => 'done',
    noteDispatch: () => true,
    beginWork: () => true,
    endWork: () => undefined,
    persist: () => true,
    newId: () => 'dsp-1',
    now: () => 1_700_000_000_000,
    ...over
  }
}

describe('dispatch to a sleeping agent', () => {
  it('wakes it and accepts the work', async () => {
    const woke: string[] = []
    const service = new DispatchService(deps({ wake: async (id) => { woke.push(id); return true } }))
    const response = await service.dispatch('forge', { text: 'run the tests' })
    expect(woke).toEqual(['forge'])
    expect(response.status).toBe(202)
  })

  it('still answers unreachable when there is nothing to wake', async () => {
    const service = new DispatchService(deps({ wake: async () => false }))
    const response = await service.dispatch('forge', { text: 'run the tests' })
    expect(response.status).toBe(503)
  })

  it('does not wake an agent whose session is already there', async () => {
    const woke: string[] = []
    const service = new DispatchService(
      deps({ sessionExists: () => true, wake: async (id) => { woke.push(id); return true } })
    )
    await service.dispatch('forge', { text: 'run the tests' })
    expect(woke).toEqual([])
  })
})
