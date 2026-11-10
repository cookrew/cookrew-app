import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConsoleDevices, DEVICES_COPY, MIN_MACHINE_VERSION, standingOf, type DevicesDeps } from '../src/renderer/src/console/console-devices'
import type { AccountMachine, AccountMachines } from '../src/shared/zoom-fleet'
import type { FleetSnapshot } from '../src/shared/fleet'
import type { MachineBlock } from '../src/renderer/src/relay-machine-call'

/**
 * THE CONSOLE'S MACHINES (0.6.0). Before the gate: each machine's name, its
 * platform and whether it is online, from the registry, and nothing from
 * inside any of them. Past the gate: each machine that can be read is asked
 * for its own summary, with this browser's own key for that machine, and its
 * screen lights up. A machine that cannot be read says the one thing to do.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const OLD = '33333333-3333-4333-8333-333333333333'

const row = (id: string, name: string, over: Partial<AccountMachine> = {}): AccountMachine => ({
  id,
  name,
  online: true,
  lastSeenAt: 5,
  appVersion: '0.6.0',
  profile: { kind: 'laptop', model: null, label: null, vendor: null, os: 'darwin', osVersion: null, arch: 'arm64', cpus: null, memoryGb: null, evidence: [] } as never,
  workspaces: [],
  current: false,
  ...over
})

const snapshot = (name: string): FleetSnapshot =>
  ({
    v: 1,
    rev: 1,
    at: 1_000,
    machine: { name, appVersion: '0.6.0', profile: null },
    focusedWorkspaceId: 'w1',
    workspaces: [
      {
        id: 'w1',
        name: 'cookrew',
        icon: null,
        traits: ['code'],
        state: 'focused',
        agents: [
          { id: 'a1', name: 'Roaster', harness: 'claude', model: null, orch: true, phase: 'waiting', phaseSource: 'live', phaseSince: null, task: null, reply: null, turns: 0, attachments: [] },
          { id: 'a2', name: 'Console', harness: 'claude', model: null, orch: false, phase: 'thinking', phaseSource: 'live', phaseSince: null, task: null, reply: null, turns: 0, attachments: [] }
        ],
        loose: [],
        counts: { agents: 2, notes: 1, browsers: 3 }
      }
    ]
  }) as unknown as FleetSnapshot

interface World {
  deps: DevicesDeps
  asked: string[]
  reproofs: number
  signedOut: number
  set: (next: Partial<{ account: AccountMachines; open: boolean; snapshots: Record<string, unknown>; blocks: Record<string, MachineBlock> }>) => void
}

const world = (start: { account?: AccountMachines; open?: boolean; snapshots?: Record<string, unknown>; blocks?: Record<string, MachineBlock> } = {}): World => {
  let account: AccountMachines = start.account ?? { ok: true, machines: [row(A, 'Studio Mac'), row(B, 'Solis-Core', { profile: null }), row(OLD, 'Old Mini', { appVersion: '0.5.10' })] }
  let open = start.open ?? false
  let snapshots: Record<string, unknown> = start.snapshots ?? {}
  let blocks: Record<string, MachineBlock> = start.blocks ?? {}
  const w: World = {
    asked: [],
    reproofs: 0,
    signedOut: 0,
    set: (next) => {
      if (next.account) account = next.account
      if (next.open !== undefined) open = next.open
      if (next.snapshots) snapshots = next.snapshots
      if (next.blocks) blocks = next.blocks
    },
    deps: {
      account: async () => account,
      fleetOf: async (id) => {
        w.asked.push(id)
        return snapshots[id] ?? null
      },
      why: (id) => blocks[id] ?? null,
      gateOpen: () => open,
      onReproof: () => void (w.reproofs += 1),
      onSignedOut: () => void (w.signedOut += 1)
    }
  }
  return w
}

/** Signed in, with the Devices level on screen. */
const shown = (store: ReturnType<typeof createConsoleDevices>): (() => void) => {
  const stopKnowing = store.start()
  const stopWatching = store.watch()
  return () => {
    stopWatching()
    stopKnowing()
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('before the gate', () => {
  it('lists every machine by name, platform and whether it is online, and asks no machine anything', async () => {
    const w = world()
    const store = createConsoleDevices(w.deps)
    expect(store.get()).toMatchObject({ status: 'loading', machines: [] })
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    const { status, machines } = store.get()
    expect(status).toBe('ready')
    expect(machines.map((m) => [m.name, m.os, m.online, m.standing])).toEqual([
      ['Studio Mac', 'darwin', true, 'locked'],
      ['Solis-Core', null, true, 'locked'],
      ['Old Mini', 'darwin', true, 'outdated']
    ])
    // Nothing from inside any machine: no workspaces, no numbers.
    expect(machines.every((m) => m.workspaces.length === 0 && m.counts === null)).toBe(true)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(w.asked).toEqual([])
    stop()
  })

  it('does not show even the workspace names an old registry answer might carry', async () => {
    const w = world({ account: { ok: true, machines: [row(A, 'Studio Mac', { workspaces: [{ id: 'w1', name: 'Secret Plans' }] })] } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    expect(JSON.stringify(store.get())).not.toContain('Secret Plans')
    stop()
  })
})

describe('past the gate', () => {
  it('asks each machine that can be read for its own summary, and lights its screen with it', async () => {
    const w = world({ open: true, snapshots: { [A]: snapshot('Studio Mac') } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    const [studio, solis, old] = store.get().machines
    expect(studio).toMatchObject({ standing: 'live', say: null })
    expect(studio.workspaces).toEqual([{ id: 'w1', name: 'cookrew', icon: null, agents: 2, waiting: 1, working: 1 }])
    expect(studio.counts).toMatchObject({ agents: 2, notes: 1, browsers: 3, waiting: 1 })
    // Asked, not yet answered: its screen is on and empty, not a claim of zero.
    expect(solis).toMatchObject({ standing: 'reading', workspaces: [], counts: null })
    // Never asked: it cannot answer this build.
    expect(old.standing).toBe('outdated')
    expect(w.asked.sort()).toEqual([A, B].sort())
    stop()
  })

  it('reads again every few seconds while it is shown, and stops when it is not', async () => {
    const w = world({ open: true, snapshots: { [A]: snapshot('Studio Mac') }, account: { ok: true, machines: [row(A, 'Studio Mac')] } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    const once = w.asked.length
    await vi.advanceTimersByTimeAsync(5_000)
    expect(w.asked.length).toBe(once + 1)
    stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.asked.length).toBe(once + 1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never has two questions out to one machine', async () => {
    const w = world({ open: true, account: { ok: true, machines: [row(A, 'Studio Mac')] } })
    const store = createConsoleDevices({ ...w.deps, fleetOf: (id) => (w.asked.push(id), new Promise(() => undefined)) })
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(w.asked).toEqual([A])
    stop()
  })

  it('opening the gate while the page is up reads the machines at once', async () => {
    const w = world({ snapshots: { [A]: snapshot('Studio Mac') } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().machines[0].standing).toBe('locked')
    w.set({ open: true })
    store.gateChanged()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().machines[0].standing).toBe('live')
    stop()
  })

  it('closing it forgets what was read: nothing from inside a machine stays on a page that may no longer see it', async () => {
    const w = world({ open: true, snapshots: { [A]: snapshot('Studio Mac') } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().machines[0].standing).toBe('live')
    w.set({ open: false })
    store.gateChanged()
    expect(store.get().machines[0]).toMatchObject({ standing: 'locked', workspaces: [], counts: null })
    stop()
  })
})

describe('inside a machine, with the Devices level off screen', () => {
  it('goes on knowing the account’s machines and asks none of them for a summary', async () => {
    const w = world({ open: true, snapshots: { [A]: snapshot('Studio Mac') } })
    const store = createConsoleDevices(w.deps)
    const stop = store.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.get().status).toBe('ready')
    expect(store.get().machines).toHaveLength(3)
    expect(w.asked).toEqual([])
    // On screen again: read at once.
    const off = store.watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.asked.sort()).toEqual([A, B].sort())
    off()
    const asked = w.asked.length
    await vi.advanceTimersByTimeAsync(30_000)
    expect(w.asked.length).toBe(asked)
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a machine that cannot be read says the one thing to do', () => {
  it('an older build: update it', () => {
    expect(standingOf(row(OLD, 'Old Mini', { appVersion: '0.5.10' }), { open: true, read: false, block: null })).toEqual({ standing: 'outdated', say: DEVICES_COPY.outdated('Old Mini') })
    expect(standingOf(row(OLD, 'Old Mini', { appVersion: null }), { open: true, read: false, block: null }).standing).toBe('outdated')
    expect(standingOf(row(A, 'Studio Mac', { appVersion: MIN_MACHINE_VERSION }), { open: true, read: true, block: null }).standing).toBe('live')
    expect(standingOf(row(A, 'Studio Mac', { appVersion: '0.7.1' }), { open: true, read: true, block: null }).standing).toBe('live')
  })

  it('off its line: open Cookrew on it', () => {
    expect(standingOf(row(A, 'Studio Mac', { online: false }), { open: true, read: false, block: null })).toEqual({ standing: 'offline', say: DEVICES_COPY.offline('Studio Mac') })
    // Offline says so before anything about its version: an old machine that is off is first of all off.
    expect(standingOf(row(A, 'Old Mini', { online: false, appVersion: '0.5.0' }), { open: false, read: false, block: null }).standing).toBe('offline')
  })

  it('it refused this browser: its own words', () => {
    expect(standingOf(row(A, 'Studio Mac'), { open: true, read: false, block: { kind: 'refused', message: 'Remote access is off on this Mac.' } })).toEqual({
      standing: 'blocked',
      say: 'Remote access is off on this Mac.'
    })
    expect(standingOf(row(A, 'Studio Mac'), { open: true, read: false, block: { kind: 'offline' } })).toEqual({ standing: 'blocked', say: DEVICES_COPY.silent('Studio Mac') })
  })

  it('a machine that wants a new proof closes the gate, once', async () => {
    const w = world({ open: true, blocks: { [A]: { kind: 'needs-proof' } }, account: { ok: true, machines: [row(A, 'Studio Mac')] } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(w.reproofs).toBe(1)
    stop()
  })
})

describe('the registry', () => {
  it('saying the session is over signs the page out', async () => {
    const w = world({ account: { ok: false, reason: 'signed-out' } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.signedOut).toBe(1)
    stop()
  })

  it('not answering keeps what was shown and says so; answering again clears it', async () => {
    const w = world()
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    w.set({ account: { ok: false, reason: 'offline' } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.get()).toMatchObject({ status: 'ready', error: DEVICES_COPY.unreachable })
    expect(store.get().machines).toHaveLength(3)
    w.set({ account: { ok: true, machines: [row(A, 'Studio Mac')] } })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(store.get()).toMatchObject({ status: 'ready', error: null })
    expect(store.get().machines).toHaveLength(1)
    stop()
  })

  it('not answering the first time is a failure the page can show, not an endless wait', async () => {
    const w = world({ account: { ok: false, reason: 'offline' } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get()).toMatchObject({ status: 'failed', error: DEVICES_COPY.unreachable, machines: [] })
    stop()
  })

  it('an account with no machines is ready, with none', async () => {
    const w = world({ account: { ok: true, machines: [] } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get()).toMatchObject({ status: 'ready', machines: [], error: null })
    stop()
  })
})
