import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WorkspaceStore } from '../../src/main/store'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { boardSourcesFrom, createProbeSampler, type ProbeDeps } from '../../src/main/board-index'
import { ADMISSION_FRESH_MS, HerdrHostMultiplexer, type AsyncCliRunner } from '../../src/main/herdr-host-multiplexer'
import { handleMobileApi, type MobileApiDeps } from '../../src/main/mobile-api'
import { latencyStats } from '../../src/shared/stats'
import type { CommandRunner } from '../../src/main/multiplexer'
import { createSessionDrain, SESSION_DRAIN_TICK_MS } from '../../src/main/session-drain'
import { DRAIN_DEBOUNCE_MS } from '../../src/main/session-registry'
import type { TerminalNodeData } from '../../src/shared/model'
import { LATENCY } from './budgets'
import { expectEvery, expectTail, measure, removeRoot, report, tempRoot } from './perf-harness'

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
 * sum of the synchronous segments between its awaits (the observe seam),
 * because the awaits are libuv's and the stall it could cause is only the
 * sync part. The pass is made to outlast ADMISSION_FRESH_MS on purpose, so
 * the listing count asserts what happens in the field — the probe's one
 * listing plus the async refresh a stale admission cache kicks — and not a
 * fixture that finishes before the cache can go stale.
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
/** Per fake pane read. 40 × 15 ms ≈ 600 ms per pass: past one freshness window. */
const READ_MS = 15
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
      // A real child takes tens of ms; forty of these outlast the 500 ms
      // admission freshness window, which is the field's shape.
      await new Promise((resolve) => setTimeout(resolve, READ_MS))
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
      const started = performance.now()
      const phases = await sampler.sampleAsync()
      const wallMs = performance.now() - started
      // The probe lists once. Each capture past ADMISSION_FRESH_MS finds the
      // admission cache stale and kicks ONE async refresh per window — that
      // is the contract, and the most listings a pass of this length allows.
      const allowedListings = 1 + Math.ceil(wallMs / ADMISSION_FRESH_MS)
      return {
        elapsed: held,
        structural: {
          syncChildren: calls.sync,
          listingsWithinContract: calls.asyncList >= 1 && calls.asyncList <= allowedListings,
          listings: calls.asyncList,
          reads: calls.asyncRead,
          phases: phases.size,
          outlastsFreshness: wallMs > ADMISSION_FRESH_MS
        }
      }
    }, 10)
    expectTail(measured, LATENCY.probeTick40Detached)
    expectEvery(measured, 'syncChildren', 0)
    expectEvery(measured, 'listingsWithinContract', true)
    expectEvery(measured, 'outlastsFreshness', true)
    expectEvery(measured, 'reads', 40)
    expectEvery(measured, 'phases', 40)
    process.stdout.write(`perf probe tick listings per pass: ${[...new Set(measured.structurals.map((s) => s.listings))].join(', ')}\n`)
  })
})

// ---------------------------------------------------------------------------
// A board READ while a pass is in flight: it must not wait on the pass.
// ---------------------------------------------------------------------------
const TOKEN = 'perf-token'

function apiRequest(): http.IncomingMessage {
  const request = Readable.from([]) as http.IncomingMessage
  request.method = 'GET'
  request.headers = { authorization: `Bearer ${TOKEN}` }
  return request
}

function apiResponse(): { response: http.ServerResponse; status: () => number } {
  let status = 0
  const response = {
    writeHead(code: number) {
      status = code
      return this
    },
    end() {
      // body discarded
    }
  } as unknown as http.ServerResponse
  return { response, status: () => status }
}

/** A sampler over `panes` fake panes whose every read takes `readMs`. */
function slowSampler(panes: number, readMs: number) {
  const deps: ProbeDeps = {
    listSessions: () => [],
    capturePane: () => '',
    listSessionsAsync: async () => Array.from({ length: panes }, (_, i) => `cookrew_t${i}`),
    capturePaneAsync: () => new Promise<string>((resolve) => setTimeout(() => resolve(WORKING_PANE), readMs)),
    knownTerminalIds: () => Array.from({ length: panes }, (_, i) => `t${i}`),
    isAttached: () => false,
    sessionNameFor: (id) => `cookrew_${id}`,
    detectWorking: (chunk) => /esc to interrupt/.test(chunk),
    detectWaiting: () => false
  }
  const sampler = createProbeSampler(deps, 3000)
  const board = boardSourcesFrom({
    store: { focusedId: 'ws' },
    turns: { list: () => [] },
    turnStore: { loadAll: () => new Map() },
    agents: { list: () => [] },
    probe: () => {
      sampler.start()
      return sampler.phases()
    },
    probeWarm: () => sampler.warm()
  })
  const apiDeps = { pairingToken: TOKEN, board } as unknown as MobileApiDeps
  const read = async (): Promise<number> => {
    const { response, status } = apiResponse()
    const started = performance.now()
    await handleMobileApi(apiRequest(), response, new URL('http://lan.local/api/board'), apiDeps)
    const ms = performance.now() - started
    if (status() !== 200) throw new Error(`/api/board answered ${status()}`)
    return ms
  }
  return { sampler, read }
}

describe('board read — while a pass is in flight, a read with something to show never waits', () => {
  it('30 reads during a 2.4 s pass: none waits, and only an empty board waits at all', async () => {
    const { sampler, read } = slowSampler(40, 60)
    await sampler.sampleAsync() // one complete pass: there is something to show
    expect(sampler.phases().size).toBe(40)
    const pass = sampler.sampleAsync() // the next pass, in flight for ~2.4 s
    const times: number[] = []
    for (let i = 0; i < 30; i += 1) {
      times.push(await read())
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    await pass
    sampler.stop()
    const stats = latencyStats(times)
    if (!stats) throw new Error('no samples')
    const measured = { name: 'board read during pass n=30', stats, structurals: times.map((ms) => ({ waited: ms > 100 })) }
    report(measured)
    expectTail(measured, LATENCY.boardReadDuringPass)
    expectEvery(measured, 'waited', false)

    // The one read that SHOULD wait: nothing to show yet, a short pass running.
    const empty = slowSampler(10, 30)
    const started = performance.now()
    const first = await empty.read()
    empty.sampler.stop()
    expect(first, 'an empty board waits for the pass it kicked').toBeGreaterThanOrEqual(200)
    expect(performance.now() - started).toBeLessThan(1500 + 200)
    expect(empty.sampler.phases().size).toBe(10)
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

const noopFacts = {
  subscriberCount: () => 0,
  hasLiveWork: () => false,
  callsInFlight: () => 0,
  releaseTerminal: () => undefined,
  detachWorkspace: () => undefined
}

/**
 * The shipped default (multiInstance false): a switch EVICTS the outgoing
 * workspace, so a parked session is a registry entry whose store session is
 * gone and whose file is on disk. The old wiring read that file twice per
 * tick per parked session; this is the arm that can fail.
 */
function singleInstanceFleet(root: string, parked: number, terminals: number, now: () => number) {
  const store = new WorkspaceStore(root, { multiInstance: false })
  const home = store.focusedId
  const drain = createSessionDrain({ store, ...noopFacts, now })
  for (let i = 0; i < parked; i += 1) {
    const meta = store.createWorkspaceWithState(`Parked ${i}`, '/work', Array.from({ length: terminals }, (_, k) => terminal(i * 100 + k)), [])
    store.switchWorkspace(meta.id)
    drain.tick()
  }
  store.switchWorkspace(home)
  drain.tick()
  return { store, drain, home }
}

describe('session drain — single-instance, 10 parked sessions the store evicted', () => {
  it('reads nothing on the observing tick and exactly once per session on release', async () => {
    const measured = await measure('drain tick n=10 parked (single-instance)', () => {
      const root = tempRoot('drain-single')
      try {
        let clock = 1_800_000_000_000
        const { store, drain, home } = singleInstanceFleet(root, 10, 2, () => clock)
        counter.workspaceReads = 0
        counter.on = true
        const started = performance.now()
        drain.tick() // the steady-state tick: parked entries alive in the registry, gone from the store
        const elapsed = performance.now() - started
        const observing = counter.workspaceReads
        clock += DRAIN_DEBOUNCE_MS + SESSION_DRAIN_TICK_MS
        drain.tick() // release: the store's view is read once so every watch is handed back
        const releasing = counter.workspaceReads - observing
        drain.tick()
        counter.on = false
        return {
          elapsed,
          structural: {
            observingReads: observing,
            releasingReads: releasing,
            afterReads: counter.workspaceReads - observing - releasing,
            registryAfter: drain.sessions.residentCount(),
            storeResident: store.resident().length,
            home: store.focusedId === home
          }
        }
      } finally {
        counter.on = false
        removeRoot(root)
      }
    })
    expectTail(measured, LATENCY.drainTick10ParkedSingle)
    expectEvery(measured, 'observingReads', 0)
    expectEvery(measured, 'releasingReads', 10)
    expectEvery(measured, 'afterReads', 0)
    expectEvery(measured, 'registryAfter', 1)
    expectEvery(measured, 'storeResident', 1)
    expectEvery(measured, 'home', true)
  })
})

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
