import { describe, expect, it, vi } from 'vitest'
import { createRelayMachines, type RelayMachineDeps } from '../src/renderer/src/relay-machine-call'

/**
 * EVERY MACHINE OF THE ACCOUNT, FROM ANY OF THEIR PAGES (owner 2026-11-10: "the
 * /me web page must be the desktop Devices view"). A page one machine serves
 * through the relay reads and works the others with this browser's OWN key for
 * each, entering a machine's door with the account pass when it holds none, as
 * cookrew.dev/me does. Never this page's own token at another machine.
 */

const ME = '11111111-1111-4111-8111-111111111111'
const SOLIS = '22222222-2222-4222-8222-222222222222'
const BASE = `/relay/@owner/desktop/${ME}`
const SOLIS_BASE = `/relay/@owner/desktop/${SOLIS}`

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function world(over: Partial<RelayMachineDeps> = {}) {
  const store = new Map<string, string>()
  const calls: { url: string; init: RequestInit }[] = []
  const answers: Response[] = []
  const deps: RelayMachineDeps = {
    base: () => BASE,
    fetch: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return answers.shift() ?? json(200, { ok: true })
    }),
    tokens: { read: (key) => store.get(key) ?? null, write: (key, value) => void store.set(key, value), drop: (key) => void store.delete(key) },
    enter: vi.fn(async (_target: string, id: string) => ({ kind: 'entered' as const, token: `key-for-${id}`, desktopId: id, until: 0 })),
    ...over
  }
  return { deps, store, calls, answers, machines: createRelayMachines(deps) }
}

const auth = (init: RequestInit): string | undefined => (init.headers as Record<string, string>).authorization

describe('createRelayMachines', () => {
  it('a machine this browser holds no key for is entered once, with the pass, and its key kept', async () => {
    const w = world()
    w.answers.push(json(200, { cards: [], workspaces: [] }))
    expect(await w.machines.call(SOLIS, 'GET', 'api/watch/cards')).toEqual({ status: 200, body: { cards: [], workspaces: [] } })
    expect(w.deps.enter).toHaveBeenCalledWith(SOLIS_BASE, SOLIS)
    expect(w.store.get(`cr_token:${SOLIS}`)).toBe(`key-for-${SOLIS}`)
    expect(w.calls[0]?.url).toBe(`${SOLIS_BASE}/api/watch/cards`)
    expect(auth(w.calls[0]!.init)).toBe(`Bearer key-for-${SOLIS}`)
    await w.machines.call(SOLIS, 'GET', 'api/watch/cards')
    expect(w.deps.enter).toHaveBeenCalledTimes(1)
  })

  it('a key that machine no longer takes is dropped and the door asked again, once', async () => {
    const w = world()
    w.store.set(`cr_token:${SOLIS}`, 'old')
    w.answers.push(json(401, { error: 'Unauthorized' }), json(200, { fine: true }))
    expect(await w.machines.call(SOLIS, 'GET', 'api/watch/cards')).toEqual({ status: 200, body: { fine: true } })
    expect(w.calls.map((c) => auth(c.init))).toEqual(['Bearer old', `Bearer key-for-${SOLIS}`])
  })

  it('sends a POST body as JSON; refuses, sending nothing, what is not on the list', async () => {
    const w = world()
    await w.machines.call(SOLIS, 'POST', 'api/terminal/t-1/input', { text: 'hi' })
    expect(w.calls[0]?.init).toMatchObject({ method: 'POST', body: '{"text":"hi"}' })
    for (const [id, method, route] of [[SOLIS, 'POST', 'api/terminal/t-1/raw'], ['nope', 'GET', 'api/watch/cards'], [SOLIS, 'GET', 'https://evil/x']] as const) {
      expect(await w.machines.call(id, method, route)).toEqual({ status: 0, body: null })
    }
    expect(w.calls).toHaveLength(1)
  })

  it('a picture comes back as base64, as the desktop gets it', async () => {
    const w = world()
    w.answers.push(new Response(new Uint8Array([0xff, 0xd8, 9]), { status: 200, headers: { 'content-type': 'image/jpeg' } }))
    expect(await w.machines.call(SOLIS, 'GET', 'api/watch/item/b1/frame?w=640')).toEqual({ status: 200, picture: { type: 'image/jpeg', data: btoa(String.fromCharCode(0xff, 0xd8, 9)) } })
  })

  it('reads its summary and its gauges; null for anything but an answer', async () => {
    const w = world()
    w.answers.push(json(200, { v: 1, workspaces: [] }), json(500, {}))
    expect(await w.machines.fleetOf(SOLIS)).toEqual({ v: 1, workspaces: [] })
    expect(await w.machines.fleetOf(SOLIS)).toBeNull()
    expect(w.calls[0]?.url).toBe(`${SOLIS_BASE}/api/fleet`)
  })

  it('says why a machine cannot be read: no pass, its own words, or nothing answered', async () => {
    const proof = world({ enter: vi.fn(async () => ({ kind: 'needs-proof' as const })) })
    expect(await proof.machines.fleetOf(SOLIS)).toBeNull()
    expect(proof.machines.why(SOLIS)).toEqual({ kind: 'needs-proof' })
    expect(proof.calls).toHaveLength(0)
    const refused = world({ enter: vi.fn(async () => ({ kind: 'refused' as const, message: 'This machine forgot this browser.' })) })
    await refused.machines.fleetOf(SOLIS)
    expect(refused.machines.why(SOLIS)).toEqual({ kind: 'refused', message: 'This machine forgot this browser.' })
    const down = world({ fetch: vi.fn(async () => Promise.reject(new Error('down'))) })
    expect(await down.machines.call(SOLIS, 'GET', 'api/watch/cards')).toEqual({ status: 0, body: null })
    expect(down.machines.why(SOLIS)).toEqual({ kind: 'offline' })
    // Read once: what stood in the way is gone.
    const fine = world()
    await fine.machines.fleetOf(SOLIS)
    expect(fine.machines.why(SOLIS)).toBeNull()
  })

  // Security review 2026-11-10 (L2): cookrew.dev answers 401 itself when the session has ended; that is not the machine forgetting this browser.
  it('a 401 from cookrew.dev (signed out) keeps this browser’s keys; only the machine’s own 401 drops one', async () => {
    const w = world()
    w.store.set(`cr_token:${SOLIS}`, 'kept')
    w.answers.push(json(401, { error: 'unauthenticated' }))
    expect(await w.machines.call(SOLIS, 'GET', 'api/watch/cards')).toEqual({ status: 0, body: null })
    expect(w.store.get(`cr_token:${SOLIS}`)).toBe('kept')
    expect(w.deps.enter).not.toHaveBeenCalled()
  })

  it('a page that is not under the relay reads no other machine', async () => {
    const w = world({ base: () => '' })
    expect(await w.machines.call(SOLIS, 'GET', 'api/watch/cards')).toEqual({ status: 0, body: null })
    expect(w.calls).toHaveLength(0)
  })

  it('two reads at once enter the door once', async () => {
    const w = world()
    await Promise.all([w.machines.fleetOf(SOLIS), w.machines.fleetOf(SOLIS), w.machines.call(SOLIS, 'GET', 'api/watch/cards')])
    expect(w.deps.enter).toHaveBeenCalledTimes(1)
  })
})
