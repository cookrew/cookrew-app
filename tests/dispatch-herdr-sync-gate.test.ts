// Sol r10 P1 — dispatch performs ZERO synchronous herdr forks: not through
// the 202, and not through a delivery leg on a warm cache.
//
// Cached admission existence (r5-r8) removed the fork from sessionExists, but
// beginWork still resolved and REPORTED the pane before returning 202
// (reportAgentSession: paneFor → readPanes plus the `quiet` report — two
// synchronous CLI children on the accept path), and every deferred delivery
// resolved the pane again for context capture, deep capture and submitAgent,
// with a sync `agent get` on top. setImmediate changed response ordering, not
// where those forks ran: concurrent dispatches serialized a per-agent spawn
// chain on Electron main (A5's one-inventory rule, I6).
//
// The gate is STRUCTURAL: every method the dispatch path touches is driven
// against a spy sync runner that records — and throws on — any `run`, and
// records `runQuiet`/`probe` too. A warm cache plus the async seam must
// answer everything; one recorded sync call fails the gate.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DispatchService, type DispatchDeps } from '../src/main/dispatch'
import { HerdrHostMultiplexer } from '../src/main/herdr-host-multiplexer'
import { submitViaHerdr } from '../src/main/herdr-agent-wait'
import type { CommandRunner } from '../src/main/multiplexer'

vi.mock('../src/main/herdr-agent-wait', () => ({
  waitForAgentState: vi.fn(async () => true),
  submitViaHerdr: vi.fn(async () => 'submitted' as const),
  promptViaHerdr: vi.fn(async () => 'done' as const)
}))

const SESSION = 'cookrew_agent-1'

const PANE_LIST = JSON.stringify({
  id: 'cli:pane:list',
  result: {
    type: 'pane_list',
    panes: [{ pane_id: 'w1:p1', label: SESSION, agent: 'claude' }]
  }
})
const AGENT_GET = JSON.stringify({ id: 'cli:agent:get', result: { agent: { state: 'idle' } } })

interface SyncCall {
  file: string
  args: string[]
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function harness(): {
  mux: HerdrHostMultiplexer
  syncCalls: SyncCall[]
  asyncCalls: string[][]
} {
  const syncCalls: SyncCall[] = []
  const asyncCalls: string[][] = []
  const runner: CommandRunner = {
    run: (file, args) => {
      syncCalls.push({ file, args })
      throw new Error(`synchronous fork on the dispatch path: ${args.join(' ')}`)
    },
    runQuiet: (file, args) => {
      syncCalls.push({ file, args })
    },
    probe: (file, args) => {
      syncCalls.push({ file, args })
      return true
    }
  }
  const mux = new HerdrHostMultiplexer({
    session: 'cookrewtest',
    configPath: '/c',
    runner,
    settleMs: 10,
    asyncRunner: async (args) => {
      asyncCalls.push(args)
      const key = args.slice(0, 2).join(' ')
      if (key === 'pane list') return PANE_LIST
      if (key === 'agent get') return AGENT_GET
      if (key === 'pane read') return 'agent output\n> '
      if (key === 'pane report-agent-session') return '{}'
      throw new Error(`no scripted async reply for ${args.join(' ')}`)
    }
  })
  return { mux, syncCalls, asyncCalls }
}

/**
 * Deps wired exactly as the conductor wires a herdr host (index.ts):
 * admission from the cached inventory, captures on the async seam,
 * submission through mux.submitAgent, and beginWork carrying
 * watchSessionTurns' side effect — the transcript-binding report.
 */
function herdrDeps(mux: HerdrHostMultiplexer): DispatchDeps {
  return {
    resolveAgent: (id) => (id === 'agent-1' ? { name: 'Forge', workspaceId: 'ws-1' } : null),
    sessionNameFor: (id) => `cookrew_${id}`,
    sessionExists: (name) => mux.sessionExistsCached(name),
    capture: (name) => mux.captureAsync(name),
    captureDeep: (name) => mux.captureDeepAsync(name, 2000),
    submitAgent: (name, prompt, timeoutMs, signal) =>
      mux.submitAgent(name, prompt, timeoutMs, signal),
    beginWork: (id) => {
      mux.reportAgentSession(`cookrew_${id}`, '/tmp/session.jsonl')
      return 'native-file'
    },
    endWork: () => undefined,
    noteDispatch: () => true,
    persist: () => true,
    newId: () => 'dsp-sync-gate'
  }
}

beforeEach(() => {
  vi.mocked(submitViaHerdr).mockClear()
})

describe('zero synchronous runner calls — through the 202 AND the delivery leg (Sol r10)', () => {
  it('dispatch() → 202 → delivered, with every backend answer on the async seam', async () => {
    const { mux, syncCalls, asyncCalls } = harness()
    mux.primeAdmissionCache()
    await settle() // the warm cache — supervisor start does this in production

    const service = new DispatchService(herdrDeps(mux))
    const response = await service.dispatch('agent-1', { text: 'run the audit' })
    expect(response.status).toBe(202)
    // THROUGH THE 202: admission (existence) answered from the cache, and
    // beginWork's transcript-binding report went fire-and-forget — no run,
    // no runQuiet, no probe.
    expect(syncCalls).toEqual([])

    await service.settled('dsp-sync-gate')
    await settle() // the fire-and-forget session report's own promise chain
    // THROUGH THE DELIVERY LEG: context capture, deep captures, the registry
    // check and the submission all rode the async runner.
    expect(syncCalls).toEqual([])
    expect(service.get('dsp-sync-gate')?.state).toBe('running')
    expect(vi.mocked(submitViaHerdr)).toHaveBeenCalledTimes(1)

    // The side effects genuinely happened — asynchronously.
    const kinds = asyncCalls.map((args) => args.slice(0, 2).join(' '))
    expect(kinds).toContain('pane report-agent-session')
    expect(kinds).toContain('pane read')
    expect(kinds).toContain('agent get')
  })

  it('a COLD cache refuses at admission (503 unreachable) — still zero sync forks', async () => {
    const { mux, syncCalls } = harness()
    const service = new DispatchService(herdrDeps(mux))
    // No prime: the empty inventory answers refusal-safe while the kicked
    // refresh runs behind it — the documented cold-window tradeoff (one
    // classified retryable failure instead of a main-thread stall).
    const response = await service.dispatch('agent-1', { text: 'run the audit' })
    expect(response.status).toBe(503)
    expect(syncCalls).toEqual([])
  })
})

describe('reportAgentSession — async-safe, single-flight, cold-cache retry (Sol r10)', () => {
  it('is single-flight per name+path while a report is in flight', async () => {
    const { mux, syncCalls, asyncCalls } = harness()
    mux.primeAdmissionCache()
    await settle()

    mux.reportAgentSession(SESSION, '/tmp/a.jsonl')
    mux.reportAgentSession(SESSION, '/tmp/a.jsonl') // dropped: same key in flight
    mux.reportAgentSession(SESSION, '/tmp/b.jsonl') // a DIFFERENT binding rides
    await settle()
    const reports = asyncCalls.filter((args) => args[1] === 'report-agent-session')
    expect(reports).toHaveLength(2)
    expect(syncCalls).toEqual([])

    // Not once-ever: a later re-report (idempotent by contract) goes out.
    mux.reportAgentSession(SESSION, '/tmp/a.jsonl')
    await settle()
    expect(asyncCalls.filter((args) => args[1] === 'report-agent-session')).toHaveLength(3)
  })

  it('skips on a cold cache and retries asynchronously once the inventory publishes', async () => {
    const { mux, syncCalls, asyncCalls } = harness()
    // Cold: no pane to resolve. The report is SKIPPED (never a sync fork),
    // the refresh is kicked, and the bounded async retry lands the report
    // once the publish answers.
    mux.reportAgentSession(SESSION, '/tmp/session.jsonl')
    expect(asyncCalls.filter((args) => args[1] === 'report-agent-session')).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 50)) // settleMs=10 retry cadence
    expect(asyncCalls.filter((args) => args[1] === 'report-agent-session')).toHaveLength(1)
    expect(syncCalls).toEqual([])
  })
})
