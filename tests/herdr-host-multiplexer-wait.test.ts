// Sol r9 P1 — retirement can cancel the post-acknowledgement reply wait.
//
// After submitAgent returns, the ask's reply-wait runs through
// waitUntilIdle → waitForAgentState → `herdr agent wait`. That leg used to
// take no AbortSignal, so retiring the terminal aborted no child: the CLI
// process, its pipes and the stale session survived for the full ask
// timeout. The signal now rides every leg — these tests pin the threading
// through the multiplexer for both the reply wait and the submission.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HerdrHostMultiplexer } from '../src/main/herdr-host-multiplexer'
import { submitViaHerdr, waitForAgentState } from '../src/main/herdr-agent-wait'
import type { CommandRunner } from '../src/main/multiplexer'

vi.mock('../src/main/herdr-agent-wait', () => ({
  waitForAgentState: vi.fn(async () => true),
  submitViaHerdr: vi.fn(async () => 'submitted' as const),
  promptViaHerdr: vi.fn(async () => 'done' as const)
}))

const PANE_LIST = JSON.stringify({
  id: 'cli:pane:list',
  result: { type: 'pane_list', panes: [{ pane_id: 'w1:p1', label: 'cookrew_abc' }] }
})

const AGENT_GET = JSON.stringify({ id: 'cli:agent:get', result: { agent: { state: 'idle' } } })

function runner(): CommandRunner {
  return {
    run: (_file, args) => {
      const key = args.slice(0, 2).join(' ')
      if (key === 'pane list') return PANE_LIST
      if (key === 'agent get') return AGENT_GET
      throw new Error(`no scripted reply for ${key}`)
    },
    runQuiet: () => {},
    probe: () => true
  }
}

const mux = (): HerdrHostMultiplexer =>
  new HerdrHostMultiplexer({ session: 'cookrewtest', configPath: '/c', runner: runner() })

/**
 * The delivery legs (submitAgent) resolve their pane from the CACHED
 * inventory and check the registry on the ASYNC runner now (Sol r10 P1) —
 * zero synchronous forks — so their backend answers ride the async seam and
 * the cache is warmed before the call.
 */
const warmMux = async (): Promise<HerdrHostMultiplexer> => {
  const backend = new HerdrHostMultiplexer({
    session: 'cookrewtest',
    configPath: '/c',
    runner: runner(),
    asyncRunner: async (args) => {
      const key = args.slice(0, 2).join(' ')
      if (key === 'pane list') return PANE_LIST
      if (key === 'agent get') return AGENT_GET
      throw new Error(`no scripted async reply for ${key}`)
    }
  })
  backend.primeAdmissionCache()
  await new Promise((resolve) => setTimeout(resolve, 0))
  return backend
}

beforeEach(() => {
  vi.mocked(waitForAgentState).mockClear()
  vi.mocked(submitViaHerdr).mockClear()
})

describe('waitUntilIdle — the reply-wait leg is cancellable (Sol r9)', () => {
  it('threads the AbortSignal through to waitForAgentState', async () => {
    const controller = new AbortController()
    await expect(mux().waitUntilIdle('cookrew_abc', 5000, controller.signal)).resolves.toBe(true)
    expect(vi.mocked(waitForAgentState)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(waitForAgentState)).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'w1:p1',
        timeoutMs: 5000,
        signal: controller.signal
      })
    )
  })

  it('still answers false for an unknown session without touching the CLI wait', async () => {
    await expect(mux().waitUntilIdle('cookrew_nope', 5000, new AbortController().signal))
      .resolves.toBe(false)
    expect(vi.mocked(waitForAgentState)).not.toHaveBeenCalled()
  })
})

describe('submitAgent — the submission leg already carries the signal (verified)', () => {
  it('threads the AbortSignal through to submitViaHerdr', async () => {
    const controller = new AbortController()
    const backend = await warmMux()
    await expect(backend.submitAgent('cookrew_abc', 'the brief', 1000, controller.signal))
      .resolves.toBe('submitted')
    expect(vi.mocked(submitViaHerdr)).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'w1:p1',
        prompt: 'the brief',
        timeoutMs: 1000,
        signal: controller.signal
      })
    )
  })

  it('answers a COLD inventory with an honest failed, never a synchronous fork (Sol r10)', async () => {
    // No prime: the cache is cold. The sync runner would throw on any
    // unscripted fork; instead the leg kicks the async refresh and refuses.
    const backend = new HerdrHostMultiplexer({
      session: 'cookrewtest',
      configPath: '/c',
      runner: { run: () => { throw new Error('sync fork on a delivery leg') }, runQuiet: () => {}, probe: () => true },
      asyncRunner: async () => PANE_LIST
    })
    await expect(backend.submitAgent('cookrew_abc', 'the brief', 1000)).resolves.toBe('failed')
    expect(vi.mocked(submitViaHerdr)).not.toHaveBeenCalled()
    // The refusal kicked the refresh: once it publishes, the retry succeeds.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await expect(backend.submitAgent('cookrew_abc', 'the brief', 1000)).resolves.toBe('submitted')
  })
})
