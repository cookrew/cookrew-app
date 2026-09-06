// The RESIDENCY drain AS WIRED (src/main/session-drain.ts), not a copy of its
// wiring. (tests/session-drain.test.ts is the older SessionTurnSync file
// drain — a different clock over a different thing.)
//
// PERF-N (scratchpad/perf-n-harness.mjs): a parked session must cost ZERO,
// measured. What is pinned here is the shape no fast machine can fake — a
// drain tick over forty parked sessions performs zero workspace reads, on
// the tick that observes them dead, on the tick that releases them, and
// after — while the death-clock semantics session-registry.test.ts pins
// (two ticks, debounced, release order) stay exactly as they were.

import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WorkspaceStore } from '../src/main/store'
import { createSessionDrain, SESSION_DRAIN_TICK_MS } from '../src/main/session-drain'
import { DRAIN_DEBOUNCE_MS } from '../src/main/session-registry'
import type { TerminalNodeData } from '../src/shared/model'

// Count workspace.json reads the way tests/perf/latency.perf.ts does: on the
// default export, with the ESM bindings re-synced.
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

function terminal(i: number): TerminalNodeData {
  return {
    kind: 'terminal',
    id: `term-${i}-${Math.random().toString(36).slice(2, 8)}`,
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

/** A store holding `parked` workspaces of `terminals` terminals each, all resident, one focused. */
function parkedFleet(parked: number, terminals: number) {
  const base = mkdtempSync(path.join(tmpdir(), 'cookrew-drain-'))
  const store = new WorkspaceStore(base, { multiInstance: true })
  const home = store.focusedId
  const ids: string[] = []
  for (let i = 0; i < parked; i += 1) {
    const meta = store.createWorkspaceWithState(
      `Parked ${i}`,
      '/work',
      Array.from({ length: terminals }, (_, k) => terminal(i * 100 + k)),
      []
    )
    store.switchWorkspace(meta.id) // hydrates it; multi-instance keeps it resident
    ids.push(meta.id)
  }
  store.switchWorkspace(home)
  expect(store.resident()).toHaveLength(parked + 1)
  return { base, store, home, ids }
}

describe('the drain over forty parked sessions', () => {
  const roots: string[] = []
  afterEach(() => {
    counter.on = false
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('performs zero workspace reads, on every tick, release included', () => {
    const { base, store, home, ids } = parkedFleet(40, 5)
    roots.push(base)
    let clock = 1_800_000_000_000
    const journal: string[] = []
    const drain = createSessionDrain({
      store,
      subscriberCount: () => 0,
      hasLiveWork: () => false,
      callsInFlight: () => 0,
      releaseTerminal: (tid) => journal.push(`release:${tid}`),
      detachWorkspace: (id) => journal.push(`detach:${id}`),
      now: () => clock
    })

    counter.workspaceReads = 0
    counter.on = true
    drain.tick() // materialises 41, observes 40 dead
    expect(drain.sessions.residentCount()).toBe(41)
    clock += DRAIN_DEBOUNCE_MS + SESSION_DRAIN_TICK_MS
    drain.tick() // releases the 40
    drain.tick() // and has nothing left to walk but the focused one
    counter.on = false

    expect(counter.workspaceReads).toBe(0)
    expect(drain.sessions.resident()).toEqual([home])
    expect(store.resident()).toEqual([home])
    const detached = journal.filter((e) => e.startsWith('detach:')).map((e) => e.slice('detach:'.length))
    expect(detached.sort()).toEqual([...ids].sort())
    expect(journal.filter((e) => e.startsWith('release:'))).toHaveLength(40 * 5)
    // Release order per workspace: every terminal handed back BEFORE its detach.
    for (const id of ids) {
      const detachAt = journal.indexOf(`detach:${id}`)
      for (const tid of store.workspaceState(id).nodes.map((n) => n.id)) {
        const releaseAt = journal.indexOf(`release:${tid}`)
        expect(releaseAt, `${tid} released before ${id} detached`).toBeGreaterThanOrEqual(0)
        expect(releaseAt).toBeLessThan(detachAt)
      }
    }
  })

  it('keeps a parked session alive on any one fact, still without reading', () => {
    const { base, store, ids } = parkedFleet(3, 2)
    roots.push(base)
    let clock = 1_800_000_000_000
    const [watched, working, called] = ids
    const busyTerminal = store.terminalIdsOf(working)[0]
    const drain = createSessionDrain({
      store,
      subscriberCount: (tid) => (store.terminalIdsOf(watched).includes(tid) ? 1 : 0),
      hasLiveWork: (tid) => tid === busyTerminal,
      callsInFlight: (id) => (id === called ? 1 : 0),
      releaseTerminal: () => undefined,
      detachWorkspace: () => undefined,
      now: () => clock
    })
    counter.workspaceReads = 0
    counter.on = true
    for (let i = 0; i < 6; i += 1) {
      drain.tick()
      clock += SESSION_DRAIN_TICK_MS
    }
    counter.on = false
    expect(counter.workspaceReads).toBe(0)
    expect(store.resident().sort()).toEqual([store.focusedId, ...ids].sort())
  })

  it('answers a session the store no longer holds from memory and lets it go', () => {
    // A registry entry can outlive its store session (removeWorkspace drops
    // the store's copy directly). Its facts must not go to disk for it.
    const { base, store, ids } = parkedFleet(2, 2)
    roots.push(base)
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
    drain.tick()
    store.removeWorkspace(ids[0])
    expect(store.isResident(ids[0])).toBe(false)
    expect(drain.sessions.peek(ids[0])).toBeDefined()

    counter.workspaceReads = 0
    counter.on = true
    clock += DRAIN_DEBOUNCE_MS + SESSION_DRAIN_TICK_MS
    drain.tick()
    counter.on = false

    expect(counter.workspaceReads).toBe(0)
    expect(drain.sessions.peek(ids[0])).toBeUndefined()
  })

  it('the death clock is untouched: two ticks, debounced, and get() never resets it', () => {
    const { base, store, ids } = parkedFleet(1, 1)
    roots.push(base)
    let clock = 1_800_000_000_000
    const release = vi.fn()
    const drain = createSessionDrain({
      store,
      subscriberCount: () => 0,
      hasLiveWork: () => false,
      callsInFlight: () => 0,
      releaseTerminal: () => undefined,
      detachWorkspace: release,
      now: () => clock
    })
    drain.tick()
    clock += DRAIN_DEBOUNCE_MS - 1
    drain.tick()
    expect(release).not.toHaveBeenCalled()
    clock += 2
    drain.tick()
    expect(release).toHaveBeenCalledWith(ids[0])
  })
})
