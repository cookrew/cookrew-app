// Sol r11 P1 — async herdr children have an OWNER at shutdown.
//
// AsyncCliRunner children (captures, deep captures, admission refreshes,
// registry resolutions, transcript-binding reports) and the submit/prompt/
// wait legs all register as tracked operations on the multiplexer; each
// carries a linked AbortController the backend itself can fire. Before this
// registry existed, interruptAll/retireAll/cancelAllAsks could not reach
// them — a 5-second pane read or a report retry admitted before teardown
// survived the final app.quit and ran against stale state, owned by nobody.
//
// cancelAllHerdrOperations(capMs) is the one bounded gate: abort every
// tracked operation, await their settlement up to the cap, and latch the
// backend closed so a late caller is refused before any spawn. The conductor
// awaits it in before-quit, before app.quit.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HerdrHostMultiplexer, type AsyncCliRunner } from '../src/main/herdr-host-multiplexer'
import { submitViaHerdr, waitForAgentState } from '../src/main/herdr-agent-wait'
import type { CommandRunner } from '../src/main/multiplexer'

vi.mock('../src/main/herdr-agent-wait', () => ({
  waitForAgentState: vi.fn(async () => true),
  submitViaHerdr: vi.fn(async () => 'submitted' as const),
  promptViaHerdr: vi.fn(async () => 'done' as const)
}))

const SESSION = 'cookrew_abc'

const PANE_LIST = JSON.stringify({
  id: 'cli:pane:list',
  result: { type: 'pane_list', panes: [{ pane_id: 'w1:p1', label: SESSION, agent: 'claude' }] }
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A sync runner that throws on `run` — the structural zero-sync gate. */
const throwingRunner: CommandRunner = {
  run: () => {
    throw new Error('synchronous fork on an async-owned leg')
  },
  runQuiet: () => {},
  probe: () => true
}

interface SpawnedChild {
  key: string
  aborted: boolean
}

/**
 * An async runner whose non-inventory children HANG until their signal
 * aborts — the shape of a wedged CLI child at quit. On abort they settle as
 * a killed child would (rejection), which is what lets the registry drain.
 */
function hangingHarness(): { runner: AsyncCliRunner; spawned: SpawnedChild[] } {
  const spawned: SpawnedChild[] = []
  const runner: AsyncCliRunner = (args, _timeoutMs, signal) => {
    const key = args.slice(0, 2).join(' ')
    if (key === 'pane list') return Promise.resolve(PANE_LIST)
    const child: SpawnedChild = { key, aborted: false }
    spawned.push(child)
    return new Promise<string>((_resolve, reject) => {
      const die = (): void => {
        child.aborted = true
        reject(Object.assign(new Error('killed'), { signal: 'SIGTERM' }))
      }
      if (signal?.aborted) die()
      else signal?.addEventListener('abort', die, { once: true })
    })
  }
  return { runner, spawned }
}

async function warmMux(runner: AsyncCliRunner): Promise<HerdrHostMultiplexer> {
  const mux = new HerdrHostMultiplexer({
    session: 'cookrewtest',
    configPath: '/c',
    runner: throwingRunner,
    settleMs: 10,
    asyncRunner: runner
  })
  mux.primeAdmissionCache()
  await settle()
  return mux
}

const liveOpsOf = (mux: HerdrHostMultiplexer): Set<unknown> =>
  (mux as unknown as { liveOps: Set<unknown> }).liveOps

beforeEach(() => {
  vi.mocked(waitForAgentState).mockClear()
  vi.mocked(waitForAgentState).mockImplementation(async () => true)
  vi.mocked(submitViaHerdr).mockClear()
  vi.mocked(submitViaHerdr).mockImplementation(async () => 'submitted' as const)
})

describe('cancelAllHerdrOperations — abort, await, drain (Sol r11 P1)', () => {
  it('two in-flight captures + a report: every child killed, registry drained, within bound', async () => {
    const { runner, spawned } = hangingHarness()
    const mux = await warmMux(runner)

    // Three async children with no caller signal at all — the exact
    // population nothing could previously cancel.
    const capture = mux.captureAsync(SESSION)
    const deep = mux.captureDeepAsync(SESSION, 2000)
    mux.reportAgentSession(SESSION, '/tmp/session.jsonl')
    await settle()
    expect(spawned.map((child) => child.key).sort()).toEqual([
      'pane read',
      'pane read',
      'pane report-agent-session'
    ])
    expect(liveOpsOf(mux).size).toBeGreaterThanOrEqual(3)

    const before = Date.now()
    await mux.cancelAllHerdrOperations(2000)
    // Killed cooperatively — well inside the cap, not by waiting it out.
    expect(Date.now() - before).toBeLessThan(1500)
    expect(spawned.every((child) => child.aborted)).toBe(true)
    // The registry is DRAINED: nothing is left for app.quit to orphan.
    await settle()
    expect(liveOpsOf(mux).size).toBe(0)
    // The captures settle as the refusals their callers already classify.
    await expect(capture).resolves.toBeNull()
    await expect(deep).resolves.toBeNull()
  })

  it('a reply-wait child is owned too: cancelAll kills the ten-minute wait', async () => {
    vi.mocked(waitForAgentState).mockImplementation(
      ({ signal }) =>
        new Promise((resolve) => {
          if (signal?.aborted) resolve(false)
          else signal?.addEventListener('abort', () => resolve(false), { once: true })
        })
    )
    const { runner } = hangingHarness()
    const mux = await warmMux(runner)
    const waiting = mux.waitUntilIdle(SESSION, 600_000)
    await settle()
    expect(liveOpsOf(mux).size).toBe(1)
    await mux.cancelAllHerdrOperations(2000)
    await expect(waiting).resolves.toBe(false)
    expect(liveOpsOf(mux).size).toBe(0)
  })

  it('a WEDGED child that ignores the abort cannot hold the quit past the cap', async () => {
    // The child neither settles nor honors the signal — the runner-level
    // SIGKILL escalation is its problem; the cap bounds only OUR wait.
    const mux = await warmMux((args) => {
      const key = args.slice(0, 2).join(' ')
      if (key === 'pane list') return Promise.resolve(PANE_LIST)
      return new Promise<string>(() => {})
    })
    void mux.captureAsync(SESSION)
    await settle()
    const before = Date.now()
    await mux.cancelAllHerdrOperations(100)
    expect(Date.now() - before).toBeLessThan(1000)
  })

  it('after cancelAll the latch refuses NEW work before any spawn', async () => {
    const { runner, spawned } = hangingHarness()
    const mux = await warmMux(runner)
    await mux.cancelAllHerdrOperations(100)
    const spawnedBefore = spawned.length

    await expect(mux.captureAsync(SESSION)).resolves.toBeNull()
    await expect(mux.submitAgent(SESSION, 'the brief', 1000)).resolves.toBe('failed')
    await expect(mux.promptAgent(SESSION, 'the brief', 1000)).resolves.toBe('failed')
    await expect(mux.waitUntilIdle(SESSION, 1000)).resolves.toBe(false)
    expect(vi.mocked(submitViaHerdr)).not.toHaveBeenCalled()
    expect(vi.mocked(waitForAgentState)).not.toHaveBeenCalled()
    expect(spawned.length).toBe(spawnedBefore)
    expect(liveOpsOf(mux).size).toBe(0)
  })
})

describe('transcript-binding reports serialize per pane (Sol r11 P1)', () => {
  it('delayed-old / fast-new: the successor supersedes, the old child is killed', async () => {
    const reports: Array<{ path: string; aborted: boolean }> = []
    const mux = await warmMux((args, _timeoutMs, signal) => {
      const key = args.slice(0, 2).join(' ')
      if (key === 'pane list') return Promise.resolve(PANE_LIST)
      if (key === 'pane report-agent-session') {
        const entry = { path: args[args.indexOf('--agent-session-path') + 1], aborted: false }
        reports.push(entry)
        // The OLD child dawdles forever; only its kill settles it. The NEW
        // one completes instantly — the delayed-old/fast-new ordering.
        if (entry.path === '/old.jsonl') {
          return new Promise<string>((_resolve, reject) => {
            const die = (): void => {
              entry.aborted = true
              reject(Object.assign(new Error('killed'), { signal: 'SIGTERM' }))
            }
            if (signal?.aborted) die()
            else signal?.addEventListener('abort', die, { once: true })
          })
        }
        return Promise.resolve('{}')
      }
      throw new Error(`no scripted async reply for ${key}`)
    })

    mux.reportAgentSession(SESSION, '/old.jsonl')
    await settle() // the old child is in flight and dawdling
    mux.reportAgentSession(SESSION, '/new.jsonl') // rotation: the successor
    await settle()

    // Both children spawned — the old one first — but the successor KILLED
    // the predecessor: however late its completion would have landed, it can
    // no longer publish, so herdr's final binding is the new path.
    expect(reports.map((entry) => entry.path)).toEqual(['/old.jsonl', '/new.jsonl'])
    expect(reports[0].aborted).toBe(true)
  })

  it('a superseded body that never spawned may not publish AT ALL (cold-cache ordering)', async () => {
    const reported: string[] = []
    const mux = new HerdrHostMultiplexer({
      session: 'cookrewtest',
      configPath: '/c',
      runner: throwingRunner,
      settleMs: 10,
      asyncRunner: async (args) => {
        const key = args.slice(0, 2).join(' ')
        if (key === 'pane list') return PANE_LIST
        if (key === 'pane report-agent-session') {
          reported.push(args[args.indexOf('--agent-session-path') + 1])
          return '{}'
        }
        throw new Error(`no scripted async reply for ${key}`)
      }
    })
    // COLD cache: both bodies queue behind the retry sleep. The old one
    // wakes holding a stale revision and must exit without spawning — only
    // the latest requested path ever reaches herdr.
    mux.reportAgentSession(SESSION, '/old.jsonl')
    mux.reportAgentSession(SESSION, '/new.jsonl')
    await new Promise((resolve) => setTimeout(resolve, 80)) // settleMs=10 retry cadence
    expect(reported).toEqual(['/new.jsonl'])
  })
})
