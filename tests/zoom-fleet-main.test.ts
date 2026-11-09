// THE ZOOM NAVIGATOR'S DEVICES, main side: the window's hold on this desktop's
// fleet service (pushed per sender, released by the sender going), and the
// account's desktops as the registry lists them, trimmed to directory facts.
import { describe, expect, it, vi } from 'vitest'
import type { FleetEvent, FleetSnapshot } from '../src/shared/fleet'
import type { FleetService } from '../src/main/fleet/service'
import { parseAccountMachines } from '../src/shared/zoom-fleet'
import { accountMachines, createFleetHolds, registerZoomFleetIpc, ZOOM_FLEET_EVENT_CHANNEL, type FleetSender } from '../src/main/zoom-fleet'
import { PROFILE } from './fleet-fixture'

const ME = '0f8f1c2e-1111-4222-8333-944445555666'
const OTHER = '1a2b3c4d-aaaa-4bbb-8ccc-ddddeeeeffff'

const snapshot = (rev: number): FleetSnapshot => ({
  v: 1,
  rev,
  at: 1,
  machine: { name: 'Studio', appVersion: '0.3.0', profile: PROFILE },
  focusedWorkspaceId: null,
  workspaces: []
})

const fakeService = (): FleetService & { opened: number; closed: number; push: (event: FleetEvent) => void } => {
  const streams = new Set<(event: FleetEvent) => void>()
  const service = {
    opened: 0,
    closed: 0,
    push: (event: FleetEvent) => streams.forEach((send) => send(event)),
    current: () => ({ snapshot: snapshot(1), body: Buffer.from(''), etag: '' }),
    subscribe: (send: (event: FleetEvent) => void) => {
      service.opened += 1
      send({ type: 'snapshot', snapshot: snapshot(1) })
      streams.add(send)
      return () => {
        service.closed += 1
        streams.delete(send)
      }
    },
    detail: () => null,
    prewarmSteps: () => [],
    stats: () => ({ builds: 0, changes: 0, lastBuildMs: 0, maxBuildMs: 0, streams: streams.size, rev: 1 }),
    close: () => undefined
  }
  return service
}

const fakeSender = (id = 1): FleetSender & { sent: Array<[string, unknown]>; fire: (event: string, ...args: unknown[]) => void; destroyed: boolean } => {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const sender = {
    id,
    sent: [] as Array<[string, unknown]>,
    destroyed: false,
    isDestroyed: () => sender.destroyed,
    send: (channel: string, payload: unknown) => sender.sent.push([channel, payload]),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return sender
    },
    removeListener: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(listener)
      return sender
    },
    fire: (event: string, ...args: unknown[]) => [...(listeners.get(event) ?? [])].forEach((l) => l(...args))
  }
  return sender
}

/** A /v2/me/desktops row as the registry sends it: desktopBody and fleetRow spread together. */
const row = (id: string, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  deviceId: id,
  name,
  workspaces: [{ id: 'w1', name: 'cookrew' }, { id: 'w2', name: 'home' }],
  doors: [{ team: 'alpha', since: 5 }],
  reach: { addrs: ['192.168.1.20:8643'], sig: 'secret-signature' },
  names: true,
  updatedAt: 10,
  id,
  online: true,
  lastSeenAt: 20,
  appVersion: '0.3.0',
  profile: PROFILE,
  base: `/relay/@me/desktop/${id}/`,
  ...extra
})

describe('the account desktops answer', () => {
  it('keeps directory facts only, and marks the desktop asking', () => {
    const machines = parseAccountMachines([row(ME, 'Studio'), row(OTHER, 'Laptop', { online: false, profile: null })], ME.toUpperCase())
    expect(machines).toEqual([
      { id: ME, name: 'Studio', online: true, lastSeenAt: 20, appVersion: '0.3.0', profile: PROFILE, workspaces: [{ id: 'w1', name: 'cookrew' }, { id: 'w2', name: 'home' }], current: true },
      { id: OTHER, name: 'Laptop', online: false, lastSeenAt: 20, appVersion: '0.3.0', profile: null, workspaces: [{ id: 'w1', name: 'cookrew' }, { id: 'w2', name: 'home' }], current: false }
    ])
    // Addresses, signatures, doors and the relay base never reach a renderer.
    expect(JSON.stringify(machines)).not.toMatch(/192\.168|secret-signature|alpha|relay/)
  })

  it('reads an older registry row (no presence, no profile) as offline and unknown', () => {
    const [machine] = parseAccountMachines([{ deviceId: OTHER, name: 'Old Mac', workspaces: [] }], null) ?? []
    expect(machine).toEqual({ id: OTHER, name: 'Old Mac', online: false, lastSeenAt: null, appVersion: null, profile: null, workspaces: [], current: false })
  })

  it('drops rows it cannot read, refuses an answer that is not a list, and cleans a profile', () => {
    expect(parseAccountMachines({ desktops: [] }, null)).toBeNull()
    const machines = parseAccountMachines(
      [null, { name: 'no id' }, { id: OTHER }, row(ME, 'Studio', { profile: { kind: 'toaster', os: 'beos', arch: 7, cpus: 'many', evidence: ['a', 3] }, workspaces: [{ id: 'w', name: 'ok' }, { id: 4 }] })],
      null
    )
    expect(machines?.map((m) => m.id)).toEqual([ME])
    expect(machines?.[0].profile).toEqual({ kind: 'unknown', model: null, label: null, vendor: null, os: 'other', osVersion: null, arch: '', cpus: null, memoryGb: null, evidence: ['a'] })
    expect(machines?.[0].workspaces).toEqual([{ id: 'w', name: 'ok' }])
  })
})

describe('accountMachines (main)', () => {
  it('asks the registry for this account’s desktops and marks this Mac', async () => {
    const authed = vi.fn(async () => ({ ok: true as const, value: [row(ME, 'Studio'), row(OTHER, 'Laptop')] }))
    const answer = await accountMachines({ authed, deviceId: () => ME })
    expect(authed).toHaveBeenCalledWith('/v2/me/desktops')
    expect(answer.ok && answer.machines.map((m) => [m.name, m.current])).toEqual([['Studio', true], ['Laptop', false]])
  })

  it('names each refusal: no account is signed-out, a dropped network is offline, a bad body malformed', async () => {
    const ask = (value: Awaited<ReturnType<Parameters<typeof accountMachines>[0]['authed']>>) => accountMachines({ authed: async () => value, deviceId: () => null })
    expect(await ask({ ok: false, reason: 'no_account' })).toEqual({ ok: false, reason: 'signed-out' })
    expect(await ask({ ok: false, reason: 'session-expired' })).toEqual({ ok: false, reason: 'signed-out' })
    expect(await ask({ ok: false, reason: 'offline' })).toEqual({ ok: false, reason: 'offline' })
    expect(await ask({ ok: false, reason: 'rate_limited' })).toEqual({ ok: false, reason: 'refused' })
    expect(await ask({ ok: true, value: { nope: 1 } })).toEqual({ ok: false, reason: 'malformed' })
  })

  it('answers failed, not a throw, when the call itself breaks', async () => {
    const answer = await accountMachines({ authed: async () => Promise.reject(new Error('boom')), deviceId: () => null })
    expect(answer).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('the window’s hold on the fleet feed', () => {
  it('pushes a snapshot then every delta to the sender, on the fleet channel', () => {
    const service = fakeService()
    const holds = createFleetHolds(() => service)
    const sender = fakeSender()
    expect(holds.subscribe(sender)).toBe(true)
    service.push({ type: 'focus', rev: 2, workspaceId: 'w1' })
    expect(sender.sent.map((entry) => entry[0])).toEqual([ZOOM_FLEET_EVENT_CHANNEL, ZOOM_FLEET_EVENT_CHANNEL])
    expect(sender.sent[1][1]).toEqual({ type: 'focus', rev: 2, workspaceId: 'w1' })
  })

  it('refuses when the service is not up yet, so the renderer can ask again', () => {
    expect(createFleetHolds(() => null).subscribe(fakeSender())).toBe(false)
  })

  it('counts holds per sender and closes the stream on the last release', () => {
    const service = fakeService()
    const holds = createFleetHolds(() => service)
    const sender = fakeSender()
    holds.subscribe(sender)
    holds.subscribe(sender)
    expect(service.opened).toBe(2)
    expect(holds.unsubscribe(sender)).toBe(true)
    expect(holds.count()).toBe(1)
    expect(holds.unsubscribe(sender)).toBe(true)
    expect(holds.count()).toBe(0)
    expect(service.closed).toBe(2)
    expect(holds.unsubscribe(sender)).toBe(false)
  })

  it('lets go by itself when the renderer goes or the page navigates away', () => {
    const service = fakeService()
    const holds = createFleetHolds(() => service)
    const crashed = fakeSender(1)
    const navigated = fakeSender(2)
    holds.subscribe(crashed)
    holds.subscribe(navigated)
    crashed.fire('render-process-gone')
    navigated.fire('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(holds.count()).toBe(0)
    expect(service.closed).toBe(2)
  })

  it('sends nothing to a destroyed sender', () => {
    const service = fakeService()
    const holds = createFleetHolds(() => service)
    const sender = fakeSender()
    holds.subscribe(sender)
    sender.destroyed = true
    service.push({ type: 'focus', rev: 2, workspaceId: null })
    expect(sender.sent).toHaveLength(1)
  })
})

describe('registerZoomFleetIpc', () => {
  it('registers subscribe, unsubscribe, machines and gauges, and nothing named levels', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
    const service = fakeService()
    registerZoomFleetIpc((channel, listener) => void handlers.set(channel, listener), {
      service: () => service,
      authed: async () => ({ ok: true, value: [row(ME, 'Studio')] }),
      deviceId: () => ME
    })
    // fleet-of and gauges-of: another machine of the account, read with the key this one holds for it.
    expect([...handlers.keys()].sort()).toEqual(['zoom-fleet:fleet-of', 'zoom-fleet:gauges', 'zoom-fleet:gauges-of', 'zoom-fleet:machines', 'zoom-fleet:subscribe', 'zoom-fleet:unsubscribe'])
    const sender = fakeSender()
    expect(handlers.get('zoom-fleet:subscribe')?.({ sender })).toBe(true)
    expect(handlers.get('zoom-fleet:unsubscribe')?.({ sender })).toBe(true)
    expect(handlers.get('zoom-fleet:subscribe')?.({})).toBe(false)
    const answer = await handlers.get('zoom-fleet:machines')?.({})
    expect(answer).toMatchObject({ ok: true, machines: [{ id: ME, current: true }] })
  })
})
