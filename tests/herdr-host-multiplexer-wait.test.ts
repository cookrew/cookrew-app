// Sol r9 P1 — retirement can cancel the post-acknowledgement reply wait.
// Sol r11 P0-4 — cancellation cannot cross the awaited resolution gap.
// Sol r11 P1 — the reply wait resolves its pane from the bounded inventory.
//
// After submitAgent returns, the ask's reply-wait runs through
// waitUntilIdle → waitForAgentState → `herdr agent wait`. That leg used to
// take no AbortSignal, so retiring the terminal aborted no child. The signal
// now rides every leg — as a LINKED controller: the multiplexer opens a
// tracked operation per leg, the caller's abort propagates into it, and
// shutdown (cancelAllHerdrOperations) can fire the same controller without
// owning the caller's signal.
//
// Round 11 closed the last gap in that chain: submitAgent/promptAgent await
// an `agent get` before the irreversible submission, and an abort that fired
// DURING that await used to sail past it — the lookup resolved true and the
// prompt went out anyway. The legs now refuse pre-aborted signals before any
// spawn and revalidate after every awaited preflight, in the same
// synchronous stretch as the submission.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HerdrHostMultiplexer, type AsyncCliRunner } from '../src/main/herdr-host-multiplexer'
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

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A sync runner that REFUSES: the reply-wait entry and the submission legs
 * are zero-sync by structural contract (Sol r10/r11), so any `run` here is
 * itself the failure. runQuiet/probe record too — the gate counts them all.
 */
function throwingRunner(syncCalls: string[][] = []): CommandRunner {
  return {
    run: (_file, args) => {
      syncCalls.push(args)
      throw new Error(`synchronous fork on a delivery/wait leg: ${args.join(' ')}`)
    },
    runQuiet: (_file, args) => {
      syncCalls.push(args)
    },
    probe: (_file, args) => {
      syncCalls.push(args)
      return true
    }
  }
}

const scriptedAsync: AsyncCliRunner = async (args) => {
  const key = args.slice(0, 2).join(' ')
  if (key === 'pane list') return PANE_LIST
  if (key === 'agent get') return AGENT_GET
  throw new Error(`no scripted async reply for ${key}`)
}

/**
 * The delivery legs AND the reply wait resolve their pane from the CACHED
 * inventory now (Sol r10/r11 P1) — zero synchronous forks — so the backend
 * answers ride the async seam and the cache is warmed before the call.
 */
async function warmMux(
  asyncRunner: AsyncCliRunner = scriptedAsync,
  syncCalls: string[][] = []
): Promise<HerdrHostMultiplexer> {
  const backend = new HerdrHostMultiplexer({
    session: 'cookrewtest',
    configPath: '/c',
    runner: throwingRunner(syncCalls),
    asyncRunner
  })
  backend.primeAdmissionCache()
  await settle()
  return backend
}

beforeEach(() => {
  vi.mocked(waitForAgentState).mockClear()
  vi.mocked(waitForAgentState).mockImplementation(async () => true)
  vi.mocked(submitViaHerdr).mockClear()
  vi.mocked(submitViaHerdr).mockImplementation(async () => 'submitted' as const)
})

describe('waitUntilIdle — the reply-wait leg is cancellable and inventory-resolved', () => {
  it('threads a LINKED AbortSignal through to waitForAgentState', async () => {
    // The signal handed down is the tracked operation's own — linked, not
    // identical: the caller's abort must propagate into it WHILE the wait
    // runs (and shutdown can fire it without the caller). Identity was the
    // r9 shape; the link is the r11 ownership seam. The link is proven
    // mid-flight, because it dies with the operation.
    vi.mocked(waitForAgentState).mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          if (signal?.aborted) resolve(false)
          else signal?.addEventListener('abort', () => resolve(false), { once: true })
        })
    )
    const controller = new AbortController()
    const backend = await warmMux()
    const waiting = backend.waitUntilIdle('cookrew_abc', 5000, controller.signal)
    expect(vi.mocked(waitForAgentState)).toHaveBeenCalledTimes(1)
    const passed = vi.mocked(waitForAgentState).mock.calls[0][0]
    expect(passed).toMatchObject({ target: 'w1:p1', timeoutMs: 5000 })
    expect(passed.signal).toBeInstanceOf(AbortSignal)
    expect(passed.signal?.aborted).toBe(false)
    controller.abort()
    expect(passed.signal?.aborted).toBe(true)
    await expect(waiting).resolves.toBe(false)
  })

  it('still answers false for an unknown session without touching the CLI wait', async () => {
    const backend = await warmMux()
    await expect(backend.waitUntilIdle('cookrew_nope', 5000, new AbortController().signal))
      .resolves.toBe(false)
    expect(vi.mocked(waitForAgentState)).not.toHaveBeenCalled()
  })

  it('resolves the pane from the bounded inventory — NEVER a sync fork (Sol r11)', async () => {
    // A cold cache answers false (the caller keeps its quiescence fallback)
    // while the kicked refresh warms; the sync runner would throw on any
    // fork, so the false is proof of the inventory path.
    const syncCalls: string[][] = []
    const backend = new HerdrHostMultiplexer({
      session: 'cookrewtest',
      configPath: '/c',
      runner: throwingRunner(syncCalls),
      asyncRunner: scriptedAsync
    })
    await expect(backend.waitUntilIdle('cookrew_abc', 5000)).resolves.toBe(false)
    expect(vi.mocked(waitForAgentState)).not.toHaveBeenCalled()
    expect(syncCalls).toEqual([])
    // The refusal kicked the refresh: once it publishes, the wait proceeds.
    await settle()
    await expect(backend.waitUntilIdle('cookrew_abc', 5000)).resolves.toBe(true)
    expect(syncCalls).toEqual([])
  })

  it('a PRE-ABORTED signal answers false before any spawn (Sol r11 P0-4)', async () => {
    const controller = new AbortController()
    controller.abort()
    const backend = await warmMux()
    await expect(backend.waitUntilIdle('cookrew_abc', 5000, controller.signal)).resolves.toBe(false)
    expect(vi.mocked(waitForAgentState)).not.toHaveBeenCalled()
  })
})

describe('submitAgent — cancellation cannot cross the resolution gap (Sol r11 P0-4)', () => {
  it('healthy path: submits with a linked signal the caller can still fire', async () => {
    // Same mid-flight proof as the reply wait: the caller's abort reaches
    // the submission child through the linked controller for as long as the
    // submission is actually running.
    let releaseSubmit!: () => void
    vi.mocked(submitViaHerdr).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseSubmit = () => resolve('submitted' as const)
        })
    )
    const controller = new AbortController()
    const backend = await warmMux()
    const submitting = backend.submitAgent('cookrew_abc', 'the brief', 1000, controller.signal)
    await settle() // past the awaited resolution, into submitViaHerdr
    expect(vi.mocked(submitViaHerdr)).toHaveBeenCalledTimes(1)
    const passed = vi.mocked(submitViaHerdr).mock.calls[0][0]
    expect(passed).toMatchObject({ target: 'w1:p1', prompt: 'the brief', timeoutMs: 1000 })
    expect(passed.signal).toBeInstanceOf(AbortSignal)
    expect(passed.signal?.aborted).toBe(false)
    controller.abort()
    expect(passed.signal?.aborted).toBe(true)
    releaseSubmit()
    await expect(submitting).resolves.toBe('submitted')
  })

  it('an abort DURING the awaited `agent get` refuses — the prompt child never spawns', async () => {
    // THE ROUND-11 WINDOW: the interrupt fires while the registry lookup is
    // in flight. The r10 shape let the lookup resolve true and then called
    // submitViaHerdr with an already-aborted signal — whose runner spawned
    // first and killed second, a race herdr could win. Now the leg
    // revalidates the signal in the same synchronous stretch as the
    // submission: 'failed', and the spy proves no prompt child was asked for.
    let releaseGet!: (value: string) => void
    const gate = new Promise<string>((resolve) => {
      releaseGet = resolve
    })
    const backend = await warmMux(async (args) => {
      const key = args.slice(0, 2).join(' ')
      if (key === 'pane list') return PANE_LIST
      if (key === 'agent get') return gate
      throw new Error(`no scripted async reply for ${key}`)
    })
    const controller = new AbortController()
    const outcome = backend.submitAgent('cookrew_abc', 'the brief', 1000, controller.signal)
    controller.abort() // fires while the lookup is awaited
    releaseGet(AGENT_GET) // the lookup then resolves TRUE — too late to matter
    await expect(outcome).resolves.toBe('failed')
    expect(vi.mocked(submitViaHerdr)).not.toHaveBeenCalled()
  })

  it('a PRE-ABORTED signal refuses with NO exec at all — not even the resolution', async () => {
    const asyncCalls: string[][] = []
    const backend = await warmMux(async (args) => {
      asyncCalls.push(args)
      return scriptedAsync(args, 0)
    })
    const primed = asyncCalls.length // the warm-up refresh
    const controller = new AbortController()
    controller.abort()
    await expect(backend.submitAgent('cookrew_abc', 'the brief', 1000, controller.signal))
      .resolves.toBe('failed')
    expect(vi.mocked(submitViaHerdr)).not.toHaveBeenCalled()
    expect(asyncCalls.length).toBe(primed) // no `agent get`, no anything
  })

  it('answers a COLD inventory with an honest failed, never a synchronous fork (Sol r10)', async () => {
    // No prime: the cache is cold. The sync runner would throw on any
    // unscripted fork; instead the leg kicks the async refresh and refuses.
    const backend = new HerdrHostMultiplexer({
      session: 'cookrewtest',
      configPath: '/c',
      runner: throwingRunner(),
      asyncRunner: async () => PANE_LIST
    })
    await expect(backend.submitAgent('cookrew_abc', 'the brief', 1000)).resolves.toBe('failed')
    expect(vi.mocked(submitViaHerdr)).not.toHaveBeenCalled()
    // The refusal kicked the refresh: once it publishes, the retry succeeds.
    await settle()
    await expect(backend.submitAgent('cookrew_abc', 'the brief', 1000)).resolves.toBe('submitted')
  })
})

describe('two concurrent asks — zero sync runner calls end to end (Sol r11 structural gate)', () => {
  it('submission ack AND reply-wait entry both ride the inventory + async seam', async () => {
    const syncCalls: string[][] = []
    const backend = await warmMux(scriptedAsync, syncCalls)
    const asks = [1, 2].map(async () => {
      const submitted = await backend.submitAgent('cookrew_abc', 'the brief', 1000)
      expect(submitted).toBe('submitted')
      return backend.waitUntilIdle('cookrew_abc', 1000)
    })
    await expect(Promise.all(asks)).resolves.toEqual([true, true])
    // The gate: not one run/runQuiet/probe through two full ask legs —
    // concurrent owner asks must not recreate the per-ask process storm.
    expect(syncCalls).toEqual([])
    expect(vi.mocked(submitViaHerdr)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(waitForAgentState)).toHaveBeenCalledTimes(2)
  })
})
