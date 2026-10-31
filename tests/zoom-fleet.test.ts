// THE ZOOM NAVIGATOR'S DEVICES, renderer side: this desktop from its own
// levels feed (or, without one, its workspace list by name), the account's
// other desktops from the registry, joined per machine. Every name invented.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LevelsAgent, LevelsEvent, LevelsSnapshot, LevelsWorkspace } from '../src/shared/strata'
import type { AccountMachine, AccountMachines } from '../src/shared/zoom-fleet'
import type { WorkspaceList } from '../src/shared/model'
import { composeFleet, createZoomFleetStore, LOCAL_MACHINE_ID, type FleetApi, type Sight } from '../src/renderer/src/zoom/use-zoom-fleet'
import { relayAccountMachines } from '../src/renderer/src/relay-machines'
import { PROFILE } from './strata-levels-fixture'

const ME = '0f8f1c2e-1111-4222-8333-944445555666'
const OTHER = '1a2b3c4d-aaaa-4bbb-8ccc-ddddeeeeffff'

const agent = (id: string, phase: LevelsAgent['phase'], extra: Partial<LevelsAgent> = {}): LevelsAgent => ({
  id,
  name: id,
  harness: 'claude',
  model: null,
  orch: false,
  phase,
  phaseSource: 'live',
  phaseSince: null,
  task: null,
  reply: null,
  turns: 0,
  attachments: [],
  ...extra
})

const workspace = (id: string, agents: LevelsAgent[], state: LevelsWorkspace['state'] = 'background'): LevelsWorkspace => ({
  id,
  name: `ws ${id}`,
  icon: null,
  traits: ['code'],
  state,
  agents,
  loose: [{ id: `${id}-n`, kind: 'note', title: 'loose note', shared: false }],
  counts: { agents: agents.length, notes: 2, browsers: 1 }
})

const snapshot = (rev: number, workspaces: LevelsWorkspace[] = [workspace('w1', [agent('a1', 'waiting'), agent('a2', 'thinking')], 'focused'), workspace('w2', [agent('a3', 'idle')])]): LevelsSnapshot => ({
  v: 1,
  rev,
  at: 1_000,
  machine: { name: 'Studio', appVersion: '0.3.1', profile: PROFILE },
  focusedWorkspaceId: 'w1',
  workspaces
})

const machine = (id: string, name: string, current: boolean, extra: Partial<AccountMachine> = {}): AccountMachine => ({
  id,
  name,
  online: !current,
  lastSeenAt: 5,
  appVersion: '0.3.0',
  profile: null,
  workspaces: [{ id: 'r1', name: 'remote ws' }],
  current,
  ...extra
})

describe('composeFleet', () => {
  it('seats this desktop from its feed: workspaces, agents, attachments and counts', () => {
    const [local] = composeFleet({ levels: snapshot(1), link: 'live', list: null, name: null, account: null })
    expect(local).toMatchObject({ id: LOCAL_MACHINE_ID, name: 'Studio', local: true, online: true, detail: 'live', focusedWorkspaceId: 'w1', appVersion: '0.3.1', profile: PROFILE })
    expect(local.workspaces.map((w) => [w.id, w.focused, w.live, w.agents.length, w.loose.length])).toEqual([
      ['w1', true, true, 2, 1],
      ['w2', false, true, 1, 1]
    ])
    expect(local.workspaces[0].counts).toEqual({ agents: 2, notes: 2, browsers: 1, waiting: 1, working: 1 })
    expect(local.counts).toEqual({ agents: 3, notes: 4, browsers: 2, waiting: 1, working: 1 })
  })

  it('puts this desktop first under its registry id, and lists the others by name with counts unknown', () => {
    const account: AccountMachines = { ok: true, machines: [machine(OTHER, 'Laptop', false), machine(ME, 'Studio (registry)', true, { profile: PROFILE })] }
    const machines = composeFleet({ levels: snapshot(1), link: 'live', list: null, name: null, account })
    expect(machines.map((m) => [m.id, m.local, m.detail])).toEqual([
      [ME, true, 'live'],
      [OTHER, false, 'listed']
    ])
    const other = machines[1]
    expect(other).toMatchObject({ name: 'Laptop', online: true, lastSeenAt: 5, counts: null, focusedWorkspaceId: null })
    // Another Mac's agents are not readable from here: names only, never zeros.
    expect(other.workspaces).toEqual([{ id: 'r1', name: 'remote ws', icon: null, traits: [], focused: false, live: false, agents: [], loose: [], counts: null }])
  })

  it('names this desktop from its workspace list while the feed is out, or where there is none', () => {
    const list: WorkspaceList = { workspaces: [{ id: 'w1', name: 'cookrew' } as WorkspaceList['workspaces'][number], { id: 'w2', name: 'home' } as WorkspaceList['workspaces'][number]], activeId: 'w2' }
    const [local] = composeFleet({ levels: null, link: 'none', list, name: 'Studio.local', account: null })
    expect(local).toMatchObject({ name: 'Studio.local', detail: 'listed', focusedWorkspaceId: 'w2', counts: null })
    expect(local.workspaces.map((w) => [w.name, w.focused, w.live, w.counts])).toEqual([
      ['cookrew', false, false, null],
      ['home', true, false, null]
    ])
    expect(composeFleet({ levels: null, link: 'connecting', list, name: null, account: null })[0]).toMatchObject({ name: 'This desktop', detail: 'connecting' })
  })

  it('falls back to the registry’s own names for this desktop when nothing local has answered', () => {
    const account: AccountMachines = { ok: true, machines: [machine(ME, 'Studio', true)] }
    const [local] = composeFleet({ levels: null, link: 'connecting', list: null, name: null, account })
    expect(local).toMatchObject({ id: ME, name: 'Studio', workspaces: [{ id: 'r1', live: false }] })
  })
})

/** A fake bridge: the feed's subscriber and refusal are kept so a test can drive them. */
const fakeApi = (options: { feed?: boolean; machines?: () => Promise<AccountMachines>; list?: () => Promise<WorkspaceList> } = {}) => {
  const feed = {
    cb: null as ((event: LevelsEvent) => void) | null,
    refused: null as (() => void) | null,
    opens: 0,
    releases: 0
  }
  const api: FleetApi = {
    subscribeZoomFleet:
      options.feed === false
        ? undefined
        : (cb, refused) => {
            feed.opens += 1
            feed.cb = cb
            feed.refused = refused ?? null
            return () => {
              feed.releases += 1
              feed.cb = null
            }
          },
    zoomFleetMachines: options.machines ?? (async () => ({ ok: false, reason: 'signed-out' })),
    listWorkspaces: options.list ?? (async () => ({ workspaces: [], activeId: '' })),
    machineName: async () => 'Studio.local'
  }
  return { api, feed }
}

const fakeSight = () => {
  let hidden = false
  let changed: (() => void) | null = null
  const sight: Sight = {
    hidden: () => hidden,
    watch: (cb) => {
      changed = cb
      return () => {
        changed = null
      }
    }
  }
  return { sight, set: (next: boolean) => ((hidden = next), changed?.()) }
}

describe('the zoom fleet store', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is loading until the feed and the account answer, then live', async () => {
    const { api, feed } = fakeApi({ machines: async () => ({ ok: true, machines: [machine(ME, 'Studio', true), machine(OTHER, 'Laptop', false)] }) })
    const store = createZoomFleetStore(() => api)
    const seen = vi.fn()
    store.subscribe(seen)
    expect(store.get()).toMatchObject({ loading: true, error: null })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().loading).toBe(true)
    feed.cb?.({ type: 'snapshot', snapshot: snapshot(1) })
    const fleet = store.get()
    expect(fleet.loading).toBe(false)
    expect(fleet.machines.map((m) => [m.name, m.detail])).toEqual([
      ['Studio', 'live'],
      ['Laptop', 'listed']
    ])
    expect(seen).toHaveBeenCalled()
  })

  it('folds deltas, and reopens on a gap so the next frame is a snapshot', async () => {
    const { api, feed } = fakeApi()
    const store = createZoomFleetStore(() => api)
    store.subscribe(() => undefined)
    feed.cb?.({ type: 'snapshot', snapshot: snapshot(1) })
    feed.cb?.({ type: 'agent', rev: 2, workspaceId: 'w2', agent: agent('a3', 'waiting') })
    expect(store.get().machines[0].workspaces[1].counts?.waiting).toBe(1)
    feed.cb?.({ type: 'focus', rev: 9, workspaceId: 'w2' })
    expect(feed.releases).toBe(1)
    expect(feed.opens).toBe(2)
    // The last good fleet stays on screen while the feed reopens.
    expect(store.get().machines[0]).toMatchObject({ detail: 'connecting', focusedWorkspaceId: 'w1' })
    feed.cb?.({ type: 'snapshot', snapshot: { ...snapshot(10), focusedWorkspaceId: 'w2' } })
    expect(store.get().machines[0]).toMatchObject({ detail: 'live', focusedWorkspaceId: 'w2' })
  })

  it('asks again, later and later, when the desktop refuses the feed (its service is not up yet)', async () => {
    const { api, feed } = fakeApi()
    const store = createZoomFleetStore(() => api, { retryMs: 1_000 })
    store.subscribe(() => undefined)
    feed.refused?.()
    expect(feed.opens).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(feed.opens).toBe(2)
    feed.refused?.()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(feed.opens).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(feed.opens).toBe(3)
    feed.cb?.({ type: 'snapshot', snapshot: snapshot(1) })
    expect(store.get().machines[0].detail).toBe('live')
  })

  it('without a feed, shows this desktop by its workspace list, and is not an error', async () => {
    const { api } = fakeApi({ feed: false, list: async () => ({ workspaces: [{ id: 'w1', name: 'cookrew' } as WorkspaceList['workspaces'][number]], activeId: 'w1' }) })
    const store = createZoomFleetStore(() => api)
    store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get()).toMatchObject({ loading: false, error: null })
    expect(store.get().machines[0]).toMatchObject({ name: 'Studio.local', detail: 'listed', workspaces: [{ name: 'cookrew', focused: true }] })
  })

  it('says so when this desktop cannot be read at all', async () => {
    const { api } = fakeApi({ feed: false, list: async () => Promise.reject(new Error('down')) })
    const store = createZoomFleetStore(() => api)
    store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().error).toBe('This desktop’s workspaces could not be read.')
    expect(store.get().machines).toHaveLength(1)
  })

  it('reports an account that could not be asked, but not one that is signed out', async () => {
    const refusing = fakeApi({ machines: async () => ({ ok: false, reason: 'offline' }) })
    const store = createZoomFleetStore(() => refusing.api)
    store.subscribe(() => undefined)
    refusing.feed.cb?.({ type: 'snapshot', snapshot: snapshot(1) })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().error).toBe('Your other devices could not be listed: cookrew.dev did not answer.')
    expect(store.get().machines).toHaveLength(1)

    const signedOut = fakeApi()
    const quiet = createZoomFleetStore(() => signedOut.api)
    quiet.subscribe(() => undefined)
    signedOut.feed.cb?.({ type: 'snapshot', snapshot: snapshot(1) })
    await vi.advanceTimersByTimeAsync(0)
    expect(quiet.get()).toMatchObject({ error: null, loading: false })
  })

  it('stops loading after the grace even when nothing answers', async () => {
    const { api } = fakeApi({ machines: () => new Promise(() => undefined) })
    const store = createZoomFleetStore(() => api, { graceMs: 2_500 })
    store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(2_499)
    expect(store.get().loading).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(store.get().loading).toBe(false)
  })

  it('asks the account again on its clock, and keeps the same fleet when nothing changed', async () => {
    const machines = vi.fn(async (): Promise<AccountMachines> => ({ ok: true, machines: [machine(OTHER, 'Laptop', false)] }))
    const { api, feed } = fakeApi({ machines })
    const store = createZoomFleetStore(() => api, { refreshMs: 60_000 })
    store.subscribe(() => undefined)
    feed.cb?.({ type: 'snapshot', snapshot: snapshot(1) })
    await vi.advanceTimersByTimeAsync(0)
    const before = store.get()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(machines).toHaveBeenCalledTimes(2)
    expect(store.get()).toBe(before)
  })

  it('closes the feed and stops asking while the window is out of sight', async () => {
    const machines = vi.fn(async (): Promise<AccountMachines> => ({ ok: false, reason: 'signed-out' }))
    const { api, feed } = fakeApi({ machines })
    const { sight, set } = fakeSight()
    const store = createZoomFleetStore(() => api, { sight, refreshMs: 60_000 })
    store.subscribe(() => undefined)
    await vi.advanceTimersByTimeAsync(0)
    set(true)
    expect(feed.releases).toBe(1)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(machines).toHaveBeenCalledTimes(1)
    set(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(feed.opens).toBe(2)
    expect(machines).toHaveBeenCalledTimes(2)
  })

  it('survives StrictMode’s mount-unmount-mount without redialling, and lets go after the last reader', async () => {
    const { api, feed } = fakeApi()
    const store = createZoomFleetStore(() => api, { stopGraceMs: 1_000 })
    const off = store.subscribe(() => undefined)
    off()
    store.subscribe(() => undefined)()
    await vi.advanceTimersByTimeAsync(999)
    expect(feed.opens).toBe(1)
    expect(feed.releases).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(feed.releases).toBe(1)
  })
})

describe('relayAccountMachines (the phone, through cookrew.dev)', () => {
  const BASE = `/relay/@me/desktop/${ME}`

  it('reads the account’s desktops same-origin, with the cookie, and marks the desktop it is served for', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify([{ id: ME, name: 'Studio', workspaces: [] }, { id: OTHER, name: 'Laptop', workspaces: [] }]), { status: 200 }))
    const answer = await relayAccountMachines(BASE, fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith('/v2/me/desktops', { credentials: 'same-origin', cache: 'no-store' })
    expect(answer.ok && answer.machines.map((m) => [m.name, m.current])).toEqual([['Studio', true], ['Laptop', false]])
  })

  it('does not ask from a page the Mac serves itself: no account cookie there', async () => {
    const fetchImpl = vi.fn()
    expect(await relayAccountMachines('', fetchImpl)).toEqual({ ok: false, reason: 'unavailable' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('names a refusal, a dropped network and a body it cannot read', async () => {
    expect(await relayAccountMachines(BASE, async () => new Response('{}', { status: 401 }))).toEqual({ ok: false, reason: 'signed-out' })
    expect(await relayAccountMachines(BASE, async () => new Response('{}', { status: 500 }))).toEqual({ ok: false, reason: 'refused' })
    expect(await relayAccountMachines(BASE, async () => Promise.reject(new TypeError('Load failed')))).toEqual({ ok: false, reason: 'offline' })
    expect(await relayAccountMachines(BASE, async () => new Response('not json', { status: 200 }))).toEqual({ ok: false, reason: 'malformed' })
  })
})
