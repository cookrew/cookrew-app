import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../../src/main/store'
import { createProbeSampler, type ProbeDeps } from '../../src/main/board-index'
import { HerdrHostMultiplexer, type AsyncCliRunner } from '../../src/main/herdr-host-multiplexer'
import type { CommandRunner } from '../../src/main/multiplexer'
import { createSessionDrain, SESSION_DRAIN_TICK_MS } from '../../src/main/session-drain'
import { DRAIN_DEBOUNCE_MS } from '../../src/main/session-registry'
import type { TerminalNodeData } from '../../src/shared/model'
import { LATENCY } from './budgets'
import { expectEvery, expectTail, measure, removeRoot, tempRoot } from './perf-harness'

/**
 * PERF-N — the owner never feels a session (scratchpad/perf-n-harness.mjs).
 *
 * The two periodic loops whose reach is residency, each with the assertion
 * a fast machine cannot fake:
 *
 *   board probe   one pass over N detached panes runs ZERO synchronous
 *                 children — counted through the herdr host's sync runner
 *                 seam, the one every synchronous fork on Electron main goes
 *                 through — and exactly one inventory listing.
 *   session drain one tick over N parked sessions performs ZERO workspace
 *                 reads, on the tick that observes them dead, the tick that
 *                 releases them, and after.
 *
 * The wall clock is measured the way the app measures it: for the probe, the
 * loop's active time across the awaited pass (the observe seam), because the
 * awaits are libuv's and the stall they could cause is only the sync part.
 */

// ---------------------------------------------------------------------------
// Counting workspace reads, as latency.perf.ts does.
// ---------------------------------------------------------------------------
const realRead = fs.readFileSync
const counter = { on: false, workspaceReads: 0 }
beforeAll(() => {
  fs.readFileSync = function countedRead(this: unknown, file: Parameters<typeof fs.readFileSync>[0], ...rest: unknown[]) {
    if (counter.on && typeof file === 'string' && file.endsWith(`${path.sep}workspace.json`)) counter.workspaceReads += 1
    return (realRead as (...a: unknown[]) => Buffer | string).call(this, file, ...rest)
  } as typeof fs.readFileSync
  syncBuiltinESMExports()
})
afterAll(() => {
  fs.readFileSync = realRead
  syncBuiltinESMExports()
})

// ---------------------------------------------------------------------------
// The probe over a real herdr host with both runners counted.
// ---------------------------------------------------------------------------
const WORKING_PANE = '✻ Baking… (esc to interrupt)\n'
const envelope = (n: number): string =>
  JSON.stringify({
    id: 'cli:pane:list',
    result: { panes: Array.from({ length: n }, (_, i) => ({ pane_id: `w1:p${i}`, label: `cookrew_t${i}`, agent_status: 'unknown' })) }
  })

function herdrHarness(panes: number) {
  const calls = { sync: 0, asyncList: 0, asyncRead: 0 }
  const runner: CommandRunner = {
    run: () => {
      calls.sync += 1
      throw new Error('synchronous herdr child on the probe path')
    },
    runQuiet: () => {
      calls.sync += 1
    },
    probe: () => {
      calls.sync += 1
      return true
    }
  }
  const asyncRunner: AsyncCliRunner = async (args) => {
    if (args[0] === 'pane' && args[1] === 'list') {
      calls.asyncList += 1
      return envelope(panes)
    }
    if (args[0] === 'pane' && args[1] === 'read') {
      calls.asyncRead += 1
      // A real child yields to the loop; so does this.
      await new Promise((resolve) => setImmediate(resolve))
      return WORKING_PANE
    }
    throw new Error(`unexpected herdr call ${args.join(' ')}`)
  }
  const mux = new HerdrHostMultiplexer({ session: 'cookrewperf', configPath: '/tmp/cookrew-perf.toml', runner, asyncRunner })
  const deps: ProbeDeps = {
    listSessions: () => mux.listSessions(),
    capturePane: (name) => mux.capture(name) ?? '',
    listSessionsAsync: () => mux.listSessionsAsync(),
    capturePaneAsync: async (name) => (await mux.captureAsync(name)) ?? '',
    knownTerminalIds: () => Array.from({ length: panes + 20 }, (_, i) => `t${i}`), // 20 known agents with no pane
    isAttached: () => false,
    sessionNameFor: (id) => `cookrew_${id}`,
    detectWorking: (chunk) => /esc to interrupt/.test(chunk),
    detectWaiting: () => false,
    askedStatus: () => null // no herdr status: every detached pane is captured
  }
  return { calls, deps }
}

describe('board probe — one pass over 40 detached panes forks nothing synchronously', () => {
  it('holds the main thread within budget and touches only the async runner', async () => {
    const measured = await measure('probe tick n=40 detached', async () => {
      const { calls, deps } = herdrHarness(40)
      let held = -1
      const sampler = createProbeSampler(deps, 3000, { observe: (ms) => (held = ms) })
      const phases = await sampler.sampleAsync()
      return {
        elapsed: held,
        structural: { syncChildren: calls.sync, listings: calls.asyncList, reads: calls.asyncRead, phases: phases.size }
      }
    })
    expectTail(measured, LATENCY.probeTick40Detached)
    expectEvery(measured, 'syncChildren', 0)
    expectEvery(measured, 'listings', 1)
    expectEvery(measured, 'reads', 40)
    expectEvery(measured, 'phases', 40)
  })
})

// ---------------------------------------------------------------------------
// The drain over parked sessions, wired as index.ts wires it.
// ---------------------------------------------------------------------------
function terminal(i: number): TerminalNodeData {
  return {
    kind: 'terminal',
    id: `term-${i}`,
    name: `Agent ${i}`,
    preset: 'Claude Code',
    command: 'claude',
    cwd: '/work',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 400, height: 300 }
  }
}

function parkedFleet(root: string, parked: number, terminals: number) {
  const store = new WorkspaceStore(root, { multiInstance: true })
  const home = store.focusedId
  for (let i = 0; i < parked; i += 1) {
    const meta = store.createWorkspaceWithState(`Parked ${i}`, '/work', Array.from({ length: terminals }, (_, k) => terminal(i * 100 + k)), [])
    store.switchWorkspace(meta.id)
  }
  store.switchWorkspace(home)
  return { store, home }
}

describe('session drain — one tick over 40 parked sessions reads nothing', () => {
  it('observes, releases and idles within budget with zero workspace reads', async () => {
    const measured = await measure('drain tick n=40 parked', () => {
      const root = tempRoot('drain')
      try {
        const { store, home } = parkedFleet(root, 40, 5)
        let clock = 1_800_000_000_000
        const drain = createSessionDrain({
          store,
          subscriberCount: () => 0,
          hasLiveWork: () => false,
          callsInFlight: () => 0,
          releaseTerminal: () => undefined,
          detachWorkspace: () => undefined,
          now: () => clock
        })
        counter.workspaceReads = 0
        counter.on = true
        const started = performance.now()
        drain.tick() // the observing tick: 41 resident, 40 dead — the steady-state cost
        const elapsed = performance.now() - started
        clock += DRAIN_DEBOUNCE_MS + SESSION_DRAIN_TICK_MS
        drain.tick() // the releasing tick
        drain.tick()
        counter.on = false
        return {
          elapsed,
          structural: { reads: counter.workspaceReads, residentAfter: store.resident().length, registryAfter: drain.sessions.residentCount(), home: store.focusedId === home }
        }
      } finally {
        counter.on = false
        removeRoot(root)
      }
    })
    expectTail(measured, LATENCY.drainTick40Parked)
    expectEvery(measured, 'reads', 0)
    expectEvery(measured, 'residentAfter', 1)
    expectEvery(measured, 'registryAfter', 1)
    expectEvery(measured, 'home', true)
  })
})
