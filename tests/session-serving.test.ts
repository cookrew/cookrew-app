import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { writeFileSync } from 'node:fs'
import { wireServing, type ServingDeps } from '../src/main/session-serving'
import { servedTemplateFile } from '../src/main/served-persist'

/**
 * THE COMPOSITION ROOT resolves an inbound call the way the app will: a live
 * workspace as-is, a served slug into a freshly-minted (or reused) session, an
 * unknown slug as a 404. All four subsystems are faked; this proves the wiring,
 * not the subsystems (each of those is tested on its own).
 */

let base = ''
const deps = (over: Partial<ServingDeps> = {}): ServingDeps => ({
  base,
  teams: { load: (id) => (id === 'research-crew' ? { name: id } : undefined) },
  pins: { resolve: () => ({ version: 1, pinAddress: 'sha256:v1' }) },
  door: { orchOf: () => 'Conductor' },
  forkEngine: { fork: async (input) => `ws-${input.name}` },
  entry: { entryTerminalOf: (wid) => `orch-${wid}` },
  callsInFlight: { cancelWhere: () => 0 },
  remover: { remove: () => undefined },
  liveWorkspaceId: () => null,
  ...over
})

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'serving-'))
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const CREW = { serviceId: 'svc-research', templateId: 'research-crew', slug: 'research', access: 'account' as const }

describe('wireServing — resolveInboundCall', () => {
  it('answers a live workspace slug as a workspace, no mint', async () => {
    const s = wireServing(deps({ liveWorkspaceId: (slug) => (slug === 'mine' ? 'ws-owner' : null) }))
    expect(await s.resolveInboundCall('mine', 'ana')).toEqual({ kind: 'workspace', workspaceId: 'ws-owner' })
  })

  it('mints a session for a served slug and routes to its conductor', async () => {
    const s = wireServing(deps())
    s.serve(CREW)
    const call = await s.resolveInboundCall('research', 'ana')
    expect(call.kind).toBe('served')
    if (call.kind !== 'served') return
    expect(call.created).toBe(true)
    expect(call.conductorId).toBe(`orch-${call.workspaceId}`)
    expect(s.instantiator.sessions()).toHaveLength(1)
  })

  it('reuses the same caller session on a second call', async () => {
    const s = wireServing(deps())
    s.serve(CREW)
    const first = await s.resolveInboundCall('research', 'ana')
    const second = await s.resolveInboundCall('research', 'ana')
    if (first.kind !== 'served' || second.kind !== 'served') throw new Error('expected served')
    expect(second.created).toBe(false)
    expect(second.workspaceId).toBe(first.workspaceId)
  })

  it('gives two callers their own sessions', async () => {
    const s = wireServing(deps())
    s.serve(CREW)
    const ana = await s.resolveInboundCall('research', 'ana')
    const bob = await s.resolveInboundCall('research', 'bob')
    if (ana.kind !== 'served' || bob.kind !== 'served') throw new Error('expected served')
    expect(ana.workspaceId).not.toBe(bob.workspaceId)
    expect(s.instantiator.sessions()).toHaveLength(2)
  })

  it('answers an unknown slug as none — a 404, never a mint', async () => {
    const s = wireServing(deps())
    expect(await s.resolveInboundCall('nope', 'ana')).toEqual({ kind: 'none' })
  })

  it('gives a live workspace precedence over a served slug', async () => {
    const s = wireServing(deps({ liveWorkspaceId: (slug) => (slug === 'research' ? 'ws-owner' : null) }))
    s.serve(CREW)
    const call = await s.resolveInboundCall('research', 'ana')
    expect(call).toEqual({ kind: 'workspace', workspaceId: 'ws-owner' })
  })

  it('stop() makes a served slug unresolvable again', async () => {
    const s = wireServing(deps())
    s.serve(CREW)
    s.stop('svc-research')
    expect(await s.resolveInboundCall('research', 'ana')).toEqual({ kind: 'none' })
  })
})

describe('serving survives a restart — the persistence seam', () => {
  // The user-reported failure this pins: save a paid team, be told it is
  // taking calls, restart the app — and the address 404s with no signal.
  it('a new wiring over the same file still serves what the old one served', async () => {
    const persist = servedTemplateFile(base)
    const before = wireServing(deps({ persist }))
    before.serve({ ...CREW, access: 'paid', priceUsd: '2.50' })

    const after = wireServing(deps({ persist }))
    expect(after.served.bySlug('research')).toMatchObject({
      serviceId: 'svc-research',
      access: 'paid',
      priceUsd: '2.50'
    })
    expect((await after.resolveInboundCall('research', 'ana')).kind).toBe('served')
  })

  it('stop() is durable too — a reboot must not resurrect a closed door', () => {
    const persist = servedTemplateFile(base)
    const before = wireServing(deps({ persist }))
    before.serve(CREW)
    before.stop('svc-research')
    expect(wireServing(deps({ persist })).served.list()).toHaveLength(0)
  })

  it('boots with nothing served over a corrupt or missing file', () => {
    expect(servedTemplateFile(base).load()).toEqual([])
    writeFileSync(path.join(base, 'served-templates.json'), 'not json{{')
    expect(servedTemplateFile(base).load()).toEqual([])
  })

  it('drops a half-shaped record instead of opening a door it cannot describe', () => {
    writeFileSync(
      path.join(base, 'served-templates.json'),
      JSON.stringify([CREW, { serviceId: 'svc-x', slug: 'x' }, 42])
    )
    const s = wireServing(deps({ persist: servedTemplateFile(base) }))
    expect(s.served.list()).toHaveLength(1)
    expect(s.served.bySlug('research')).not.toBeNull()
  })

  it('a crew that LOST its orch comes back not-serving, rather than serving a 503', () => {
    // The rule tightened while the record sat on disk — which is the whole
    // reason the rehydrate loop refuses rather than trusts the file. The door
    // this reopens is the one the ruling closed, so a stale record must not be
    // able to walk it back in through a restart.
    writeFileSync(path.join(base, 'served-templates.json'), JSON.stringify([CREW]))
    const s = wireServing(deps({ persist: servedTemplateFile(base), door: { orchOf: () => null } }))
    expect(s.served.list()).toHaveLength(0)
    expect(s.served.bySlug('research')).toBeNull()
  })
})

describe('the orch is required to serve at all', () => {
  it('refuses serve() for a crew with no orch and does not persist it', () => {
    const persist = servedTemplateFile(base)
    const s = wireServing(deps({ persist, door: { orchOf: () => null } }))
    expect(() => s.serve(CREW)).toThrow(/needs an orch/)
    expect(s.served.list()).toHaveLength(0)
    // Nothing reached disk either — a refused serve that still wrote the file
    // would serve on the NEXT boot if the rule ever relaxed again.
    expect(persist.load()).toEqual([])
  })

  it('refusalFor answers the same verdict before the act, for the save sheet', () => {
    const withOrch = wireServing(deps())
    const without = wireServing(deps({ door: { orchOf: () => null } }))
    expect(withOrch.refusalFor(CREW)).toBeNull()
    expect(without.refusalFor(CREW)).toBe('no-orch')
  })

  it('an inbound call to an orch-less crew is a 404, not a mint', async () => {
    // The end-to-end consequence: refusing at serve means the slug never
    // resolves, so no sandbox is created and no prompt reaches a shell.
    const s = wireServing(deps({ door: { orchOf: () => null } }))
    expect(() => s.serve(CREW)).toThrow()
    expect(await s.resolveInboundCall('research', 'ana')).toEqual({ kind: 'none' })
  })
})
