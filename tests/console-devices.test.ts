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

describe('the gate changing while the account is being asked', () => {
  it('does not throw the account’s answer away: the machines are listed as soon as the registry says', async () => {
    let answer: (machines: AccountMachines) => void = () => undefined
    const w = world()
    const store = createConsoleDevices({ ...w.deps, account: () => new Promise((resolve) => void (answer = resolve)) })
    const stop = shown(store)
    // The gate settles (closed, busy, closed again) before the registry answers.
    store.gateChanged()
    store.gateChanged()
    answer({ ok: true, machines: [row(A, 'Studio Mac')] })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get()).toMatchObject({ status: 'ready' })
    expect(store.get().machines).toHaveLength(1)
    stop()
  })

  it('a machine that did not take the pass is not asked again and again while the gate stays open', async () => {
    const w = world({ open: true, blocks: { [A]: { kind: 'needs-proof' } }, account: { ok: true, machines: [row(A, 'Studio Mac')] } })
    // As the page is wired: being told has the gate look at its pass, find it, and say it is (still) open.
    const store = createConsoleDevices({ ...w.deps, onReproof: () => (w.reproofs += 1, store.gateChanged()) })
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(w.asked).toEqual([A])
    expect(w.reproofs).toBe(1)
    // A new proof (closed, then open) is a reason to ask it again.
    w.set({ open: false })
    store.gateChanged()
    w.set({ open: true })
    store.gateChanged()
    await vi.advanceTimersByTimeAsync(0)
    expect(w.asked).toEqual([A, A])
    stop()
  })

  it('a registry that says the session is over on the first ask is asked again soon, and the page says something meanwhile', async () => {
    let calls = 0
    const w = world()
    const store = createConsoleDevices({ ...w.deps, account: async () => ((calls += 1) === 1 ? { ok: false, reason: 'signed-out' } : { ok: true, machines: [row(A, 'Studio Mac')] }) })
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.signedOut).toBe(1)
    expect(store.get().status).toBe('failed')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.get()).toMatchObject({ status: 'ready', error: null })
    stop()
  })
})

describe('signed out', () => {
  it('forgets the account’s machines: the next person to sign in here is not shown the last one’s', async () => {
    const w = world({ open: true, snapshots: { [A]: snapshot('Studio Mac') } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().machines).toHaveLength(3)
    stop()
    expect(store.get()).toEqual({ status: 'loading', machines: [], error: null })
    // And the next list that fails to arrive shows nothing of the old one.
    w.set({ account: { ok: false, reason: 'offline' } })
    const again = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get()).toMatchObject({ status: 'failed', machines: [] })
    again()
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
    expect(standingOf(row(A, 'Studio Mac', { appVersion: '0.10.0' }), { open: true, read: true, block: null }).standing).toBe('live')
    // A pre-release of the first build that speaks to the console speaks to it.
    expect(standingOf(row(A, 'Studio Mac', { appVersion: '0.6.0-beta.1' }), { open: true, read: true, block: null }).standing).toBe('live')
    // A version this page cannot read is not taken for a new one.
    for (const odd of ['v0.5.0', '0.5.9-beta.1', '', 'latest', '0.6']) {
      expect(standingOf(row(OLD, 'Old Mini', { appVersion: odd }), { open: true, read: false, block: null }).standing, odd).toBe('outdated')
    }
  })

  it('off its line: open Cookrew on it', () => {
    expect(standingOf(row(A, 'Studio Mac', { online: false }), { open: true, read: false, block: null })).toEqual({ standing: 'offline', say: DEVICES_COPY.offline('Studio Mac') })
    // Offline says so before anything about its version: an old machine that is off is first of all off.
    expect(standingOf(row(A, 'Old Mini', { online: false, appVersion: '0.5.0' }), { open: false, read: false, block: null }).standing).toBe('offline')
  })

  // In a real browser, 2026-11-11: the list is asked for once a minute, so a machine closed meanwhile read "online …" until then.
  it('off its line since the list was read: the registry is asked again at once, not at the next minute, and the tile says to open Cookrew on it', async () => {
    const w = world({ open: true, snapshots: { [A]: snapshot('Studio Mac') }, account: { ok: true, machines: [row(A, 'Studio Mac')] } })
    let accountAsks = 0
    const store = createConsoleDevices({ ...w.deps, account: () => ((accountAsks += 1), w.deps.account()) })
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().machines[0]).toMatchObject({ standing: 'live' })
    expect(accountAsks).toBe(1)
    // Cookrew is closed on it: the relay says it holds no line, and the registry already lists it offline.
    w.set({ snapshots: {}, blocks: { [A]: { kind: 'offline' } }, account: { ok: true, machines: [row(A, 'Studio Mac', { online: false })] } })
    await vi.advanceTimersByTimeAsync(5_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(accountAsks).toBe(2)
    expect(store.get().machines[0]).toMatchObject({ standing: 'offline', say: 'Open Cookrew on Studio Mac.', online: false })
    stop()
  })

  it('a machine the relay cannot reach while the registry still lists it online is asked about once, not in a loop', async () => {
    const w = world({ open: true, blocks: { [A]: { kind: 'offline' } }, account: { ok: true, machines: [row(A, 'Studio Mac')] } })
    let accountAsks = 0
    const store = createConsoleDevices({ ...w.deps, account: () => ((accountAsks += 1), w.deps.account()) })
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20_000)
    // The first ask, and one more for the line that was lost: the minute's clock does the rest.
    expect(accountAsks).toBe(2)
    expect(store.get().machines[0]).toMatchObject({ standing: 'blocked', say: 'Studio Mac is not answering.' })
    // It answers again, then lets go again: that is a new loss, and is asked about once more.
    w.set({ snapshots: { [A]: snapshot('Studio Mac') }, blocks: {} })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(store.get().machines[0]).toMatchObject({ standing: 'live' })
    w.set({ snapshots: {}, blocks: { [A]: { kind: 'offline' } } })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(accountAsks).toBe(3)
    stop()
  })

  it('two machines lost in one round are one question to the registry, not one each and not a chain', async () => {
    const w = world({ open: true, blocks: { [A]: { kind: 'offline' }, [B]: { kind: 'offline' } }, account: { ok: true, machines: [row(A, 'Studio Mac'), row(B, 'Solis-Core')] } })
    let accountAsks = 0
    const store = createConsoleDevices({ ...w.deps, account: () => ((accountAsks += 1), w.deps.account()) })
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(accountAsks).toBe(2)
    // They take turns answering and letting go, each round a new loss: still no faster than the summaries' own clock.
    for (let round = 0; round < 6; round += 1) {
      w.set(round % 2 === 0 ? { snapshots: { [A]: snapshot('Studio Mac') }, blocks: { [B]: { kind: 'offline' } } } : { snapshots: { [B]: snapshot('Solis-Core') }, blocks: { [A]: { kind: 'offline' } } })
      await vi.advanceTimersByTimeAsync(5_000)
    }
    // Thirty seconds of flapping: at most one loss question per five seconds, on top of the first two.
    expect(accountAsks).toBeLessThanOrEqual(2 + 6)
    stop()
  })

  it('it refused this browser: its own words, said as its own and cut to a sentence’s length', () => {
    expect(standingOf(row(A, 'Studio Mac'), { open: true, read: false, block: { kind: 'refused', message: 'Remote access is off on this Mac.' } })).toEqual({
      standing: 'blocked',
      say: 'Studio Mac says: Remote access is off on this Mac.'
    })
    const long = standingOf(row(A, 'Studio Mac'), { open: true, read: false, block: { kind: 'refused', message: 'x'.repeat(2_000) } })
    expect((long.say ?? '').length).toBe('Studio Mac says: '.length + 160)
    expect(standingOf(row(A, 'Studio Mac'), { open: true, read: false, block: { kind: 'needs-proof' } })).toEqual({ standing: 'blocked', say: DEVICES_COPY.reproof('Studio Mac') })
    expect(standingOf(row(A, 'Studio Mac'), { open: true, read: false, block: { kind: 'no-device' } })).toEqual({ standing: 'blocked', say: DEVICES_COPY.noKey })
    expect(standingOf(row(A, 'Studio Mac'), { open: true, read: false, block: { kind: 'offline' } })).toEqual({ standing: 'blocked', say: DEVICES_COPY.silent('Studio Mac') })
  })

  it('a machine that wants a new proof has the gate look at its pass again, once, and is not what closes it', async () => {
    const w = world({ open: true, blocks: { [A]: { kind: 'needs-proof' } }, snapshots: { [B]: snapshot('Solis-Core') }, account: { ok: true, machines: [row(A, 'Studio Mac'), row(B, 'Solis-Core')] } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(w.reproofs).toBe(1)
    // The pass is still held (the gate is still open): that machine says so about itself, and the other is still read.
    expect(store.get().machines.map((m) => [m.name, m.standing])).toEqual([
      ['Studio Mac', 'blocked'],
      ['Solis-Core', 'live']
    ])
    stop()
  })

  it('a machine is called what the registry calls it, whatever it says its own name is', async () => {
    const w = world({ open: true, snapshots: { [A]: snapshot('Solis-Core (trust me)') }, account: { ok: true, machines: [row(A, 'Studio Mac')] } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().machines[0]).toMatchObject({ name: 'Studio Mac', standing: 'live' })
    stop()
  })
})

describe('the registry', () => {
  it('saying the session is over tells the session', async () => {
    const w = world({ account: { ok: false, reason: 'signed-out' } })
    const store = createConsoleDevices(w.deps)
    const stop = shown(store)
    await vi.advanceTimersByTimeAsync(0)
    expect(w.signedOut).toBe(1)
    stop()
    expect(vi.getTimerCount()).toBe(0)
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
