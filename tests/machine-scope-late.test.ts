import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bareWindow } from './support/memory-storage'
import { inConsole, relayBaseFor } from './support/console-scope'

/**
 * WORK THAT OUTLIVES ITS MACHINE.
 *
 * A request waits, a read retries, a store is asked for again while the page
 * is between two machines. Each of those is a place where machine A's address
 * could meet machine B's token, or A's answer be filed as B's. Every case
 * here starts something for A, enters B while it waits, and looks at what
 * reaches the wire and what the page believes afterwards.
 */

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const BASE_A = relayBaseFor(A)
const BASE_B = relayBaseFor(B)
const FULL = { error: 'too_many_exchanges' }

interface Sent {
  url: string
  init: RequestInit
  answer: (response: Response) => void
}

let sent: Sent[] = []
const to = (base: string, path: string): Sent[] => sent.filter((one) => one.url.startsWith(`${base}${path}`))
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const bearerOf = (one: Sent): string | null => new Headers(one.init.headers).get('authorization')
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type Scope = typeof import('../src/renderer/src/machine-scope')
type Api = typeof import('../src/renderer/src/api')
type Gate = typeof import('../src/renderer/src/auth-gate')

async function consoleAt(machineId: string | null): Promise<{ scope: Scope; api: Api; gate: Gate }> {
  vi.resetModules()
  const scope = await inConsole(machineId)
  const api = await import('../src/renderer/src/api')
  const gate = await import('../src/renderer/src/auth-gate')
  return { scope, api, gate }
}

beforeEach(() => {
  sent = []
  const page = bareWindow('https://console.cookrew.dev/')
  const stored = page.localStorage as Storage
  stored.setItem(`cr_token:${A}`, 'token-for-a')
  stored.setItem(`cr_token:${B}`, 'token-for-b')
  vi.stubGlobal('window', { ...page, COOKREW_MOBILE: 1 })
  vi.stubGlobal('localStorage', page.localStorage)
  vi.stubGlobal('document', { hidden: false, visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init: RequestInit = {}) =>
        new Promise<Response>((answer, fail) => {
          sent.push({ url: String(url), init, answer })
          init.signal?.addEventListener('abort', () => fail(init.signal?.reason ?? new DOMException('aborted', 'AbortError')), { once: true })
        })
    )
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('a store asked for while the page is between two machines', () => {
  it('is never the last machine’s once the next is in scope, whoever asked in between', async () => {
    const { scope, api, gate } = await consoleAt(A)
    // Something that, while it lets go, asks for the api and the token store again:
    // both are made for the machine still in scope at that moment, which is A.
    scope.registerScopeState('asks while letting go', () => {
      api.cookrew()
      gate.authStore()
    })
    expect(gate.authStore().token()).toBe('token-for-a')
    const forA = api.cookrew()

    scope.enterMachine(B)
    expect(gate.authStore().token()).toBe('token-for-b')
    expect(gate.authHeaders()).toEqual({ authorization: 'Bearer token-for-b' })
    expect(api.cookrew()).not.toBe(forA)
    // And what is asked of B carries B's token, never A's.
    sent = []
    void api.cookrew().getWorkspace().catch(() => undefined)
    await tick()
    const asked = to(BASE_B, '/api/workspace')
    expect(asked).toHaveLength(1)
    expect(bearerOf(asked[0])).toBe('Bearer token-for-b')
    expect(sent.some((one) => bearerOf(one) === 'Bearer token-for-a')).toBe(false)
  })

  it('with the fleet being watched: the next machine is asked with its own token', async () => {
    const { scope, api, gate } = await consoleAt(A)
    const fleet = await import('../src/renderer/src/zoom/use-zoom-fleet')
    // The zoom view was open once: the shared fleet store exists and is listened to.
    const off = fleet.sharedZoomFleet().subscribe(() => undefined)
    await tick()
    scope.enterMachine(B)
    await tick()
    expect(gate.authStore().token()).toBe('token-for-b')
    sent = []
    void api.cookrew().getWorkspace().catch(() => undefined)
    await tick()
    expect(to(BASE_B, '/api/workspace').map(bearerOf)).toEqual(['Bearer token-for-b'])
    expect(sent.some((one) => bearerOf(one) === 'Bearer token-for-a')).toBe(false)
    off()
  })
})

describe('a read that was waiting out a full relay when the machine changed', () => {
  it('is not asked again: the last machine’s address never meets the next one’s token', async () => {
    const { scope, api, gate } = await consoleAt(A)
    api.cookrew()
    await tick()
    vi.useFakeTimers()
    const reading = api.cookrew().listWorkspaces()
    const failed = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    await vi.advanceTimersByTimeAsync(0)
    const first = to(BASE_A, '/api/workspaces')
    expect(first).toHaveLength(1)
    expect(bearerOf(first[0])).toBe('Bearer token-for-a')
    first[0].answer(json(FULL, 503))
    await vi.advanceTimersByTimeAsync(10)

    scope.enterMachine(B)
    await vi.advanceTimersByTimeAsync(20_000)
    await failed
    expect(to(BASE_A, '/api/workspaces')).toHaveLength(1)
    expect(sent.filter((one) => one.url.startsWith(BASE_A)).some((one) => bearerOf(one) === 'Bearer token-for-b')).toBe(false)
    expect(gate.authStore().blocked()).toBeNull()
  })
})

describe('an answer from the last machine that lands after the next was entered', () => {
  it('a refusal does not put the next machine behind the re-pair screen', async () => {
    const { scope, api, gate } = await consoleAt(A)
    const reading = api.cookrew().getWorkspace()
    const failed = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    scope.enterMachine(B)
    to(BASE_A, '/api/workspace')[0].answer(json({ error: 'not paired' }, 401))
    await failed
    expect(gate.authStore().blocked()).toBeNull()
  })

  it('a seat it hands out is not taken for the next machine', async () => {
    const { scope, api } = await consoleAt(A)
    const seat = await import('../src/renderer/src/device-seat')
    const switching = api.cookrew().switchWorkspace('workspace-on-a')
    const failed = expect(switching).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    scope.enterMachine(B)
    to(BASE_A, '/api/workspaces/switch')[0].answer(json({ workspaces: [], activeId: 'workspace-on-a', seat: 'workspace-on-a' }))
    await failed
    expect(seat.deviceSeat()).toBeNull()
  })

  it('a boot check answered late says nothing about the next machine', async () => {
    const { scope, api, gate } = await consoleAt(A)
    api.cookrew()
    await tick()
    const check = to(BASE_A, '/api/auth/status')
    expect(check).toHaveLength(1)
    scope.enterMachine(B)
    check[0].answer(json({ scope: 'none', required: true }))
    await tick()
    await tick()
    expect(gate.authStore().blocked()).toBeNull()
  })
})

describe('the account session, on a request whose address was built for a direct path', () => {
  it('does not ride a direct address, even when the page is back on the relay by the time it is sent', async () => {
    await consoleAt(A)
    const { planeFetch } = await import('../src/renderer/src/plane-fetch')
    const direct = `https://192-168-1-7.${A}.d.cookrew.dev:8643/api/workspaces`
    void planeFetch(direct, { headers: { authorization: 'Bearer token-for-a' } }).catch(() => undefined)
    void planeFetch(`${BASE_A}/api/workspaces`, { headers: { authorization: 'Bearer token-for-a' } }).catch(() => undefined)
    await tick()
    expect(sent).toHaveLength(2)
    expect(new Headers(sent[0].init.headers).get('x-cookrew-session')).toBeNull()
    expect(new Headers(sent[0].init.headers).get('authorization')).toBe('Bearer token-for-a')
    expect(new Headers(sent[1].init.headers).get('x-cookrew-session')).toBe('account-session')
  })
})

describe('a race for a nearer path that was running when the machine changed', () => {
  it('remembers nothing of the last machine: its card, answered late, names nobody', async () => {
    const { scope } = await consoleAt(A)
    vi.stubGlobal('window', { ...(globalThis as unknown as { window: object }).window, addEventListener: () => undefined, removeEventListener: () => undefined, crypto: { getRandomValues: (bytes: Uint8Array) => bytes } })
    const session = await import('../src/renderer/src/machine-session')
    const companion = await import('../src/renderer/src/path/companion')
    const plane = await import('../src/renderer/src/data-plane')
    session.startMachineSession()
    await tick()
    const cardOfA = to(BASE_A, '/api/reach')
    expect(cardOfA.length).toBeGreaterThan(0)

    scope.enterMachine(B)
    await tick()
    for (const asked of cardOfA) {
      asked.answer(json({ deviceId: A, lan: [], tailnet: null, trusted: [`https://192-168-1-7.${A}.d.cookrew.dev:8643`] }))
    }
    await tick()
    await tick()
    expect(companion.cardDeviceId()).toBeNull()
    expect(plane.dataPlane()).toEqual({ origin: '', kind: 'relay' })
    // Nothing was tried at the last machine's own address on the next machine's behalf.
    expect(sent.some((one) => one.url.includes('.d.cookrew.dev'))).toBe(false)
    scope.enterMachine(null)
  })
})

describe('a token being verified for one machine when another is entered', () => {
  it('is kept under neither key: the next machine’s own token is not overwritten', async () => {
    const { scope } = await consoleAt(A)
    vi.doMock('../src/renderer/src/auth-gate.css', () => ({}))
    const { keepVerifiedToken } = await import('../src/renderer/src/ReauthOverlay')
    let verdict: (scope: 'pairing') => void = () => undefined
    const keeping = keepVerifiedToken('pasted-for-a', null, () => new Promise((resolve) => void (verdict = resolve)))
    scope.enterMachine(B)
    verdict('pairing')
    expect(await keeping).toBe(false)
    const stored = (globalThis as unknown as { localStorage: Storage }).localStorage
    expect(stored.getItem(`cr_token:${B}`)).toBe('token-for-b')
    expect(stored.getItem(`cr_token:${A}`)).toBe('token-for-a')
    vi.doUnmock('../src/renderer/src/auth-gate.css')
  })

  it('is kept under its own machine’s key when nothing changed', async () => {
    await consoleAt(A)
    vi.doMock('../src/renderer/src/auth-gate.css', () => ({}))
    const { keepVerifiedToken } = await import('../src/renderer/src/ReauthOverlay')
    expect(await keepVerifiedToken('pasted-for-a', null, async () => 'pairing')).toBe(true)
    const stored = (globalThis as unknown as { localStorage: Storage }).localStorage
    expect(stored.getItem(`cr_token:${A}`)).toBe('pasted-for-a')
    expect(stored.getItem(`cr_token:${B}`)).toBe('token-for-b')
    vi.doUnmock('../src/renderer/src/auth-gate.css')
  })
})

describe('an answer whose head arrived for the last machine and whose body is read under the next', () => {
  /** A response whose body is held back until `finish` is called. */
  const slow = (status: number, body: unknown): { response: Response; finish: () => void } => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null
    const stream = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) })
    return {
      response: new Response(stream, { status, headers: { 'content-type': 'application/json' } }),
      finish: () => {
        controller?.enqueue(new TextEncoder().encode(JSON.stringify(body)))
        controller?.close()
      }
    }
  }

  it('a refusal read late does not put the next machine behind the re-pair screen', async () => {
    const { scope, api, gate } = await consoleAt(A)
    const reading = api.cookrew().getWorkspace()
    const failed = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    const refusal = slow(401, { error: 'not paired' })
    to(BASE_A, '/api/workspace')[0].answer(refusal.response)
    await tick()
    scope.enterMachine(B)
    refusal.finish()
    await failed
    expect(gate.authStore().blocked()).toBeNull()
  })

  it('a seat read late is not taken for the next machine', async () => {
    const { scope, api } = await consoleAt(A)
    const seat = await import('../src/renderer/src/device-seat')
    const switching = api.cookrew().switchWorkspace('workspace-on-a')
    const failed = expect(switching).rejects.toMatchObject({ name: 'AbortError' })
    await tick()
    const answer = slow(200, { workspaces: [], activeId: 'workspace-on-a', seat: 'workspace-on-a' })
    to(BASE_A, '/api/workspaces/switch')[0].answer(answer.response)
    await tick()
    scope.enterMachine(B)
    answer.finish()
    await failed
    expect(seat.deviceSeat()).toBeNull()
  })

  it('a boot check read late says nothing about the next machine', async () => {
    const { scope, api, gate } = await consoleAt(A)
    api.cookrew()
    await tick()
    const verdict = slow(200, { scope: 'none', required: true })
    to(BASE_A, '/api/auth/status')[0].answer(verdict.response)
    await tick()
    scope.enterMachine(B)
    verdict.finish()
    await tick()
    await tick()
    expect(gate.authStore().blocked()).toBeNull()
  })
})

describe('the relay saying the account session is over', () => {
  it('is not taken for the machine refusing this browser: no re-pair screen, and the session is told', async () => {
    vi.resetModules()
    const refused = vi.fn()
    const scope = await import('../src/renderer/src/machine-scope')
    scope.configureMachineScope({ relay: { origin: 'https://api.cookrew.dev', session: () => 'account-session', refused } })
    scope.enterMachine(A)
    const api = await import('../src/renderer/src/api')
    const gate = await import('../src/renderer/src/auth-gate')
    const reading = api.cookrew().getWorkspace()
    const failed = expect(reading).rejects.toMatchObject({ status: 401 })
    await tick()
    // The registry's own words for a session it no longer takes (v2-canvas-relay.ts).
    to(BASE_A, '/api/workspace')[0].answer(json({ error: 'unauthenticated' }, 401))
    await failed
    expect(gate.authStore().blocked()).toBeNull()
    expect(refused).toHaveBeenCalledTimes(1)
  })

  it('a machine’s own refusal still is: that is the token it no longer takes', async () => {
    vi.resetModules()
    const refused = vi.fn()
    const scope = await import('../src/renderer/src/machine-scope')
    scope.configureMachineScope({ relay: { origin: 'https://api.cookrew.dev', session: () => 'account-session', refused } })
    scope.enterMachine(A)
    const api = await import('../src/renderer/src/api')
    const gate = await import('../src/renderer/src/auth-gate')
    const reading = api.cookrew().getWorkspace()
    const failed = expect(reading).rejects.toMatchObject({ name: 'AuthError' })
    await tick()
    to(BASE_A, '/api/workspace')[0].answer(json({ error: 'Unauthorized — pair this device first.' }, 401))
    await failed
    expect(gate.authStore().blocked()).not.toBeNull()
    expect(refused).not.toHaveBeenCalled()
  })
})

describe('a credential in the console’s address', () => {
  it('is not taken: a machine’s key comes through its door, never from a link', async () => {
    vi.resetModules()
    const page = bareWindow(`https://console.cookrew.dev/d/${A}?token=planted-token#pair=planted-too`)
    vi.stubGlobal('window', { ...page, COOKREW_MOBILE: 1 })
    vi.stubGlobal('localStorage', page.localStorage)
    await inConsole(A)
    const gate = await import('../src/renderer/src/auth-gate')
    expect(gate.authStore().token()).toBeNull()
    expect((page.localStorage as Storage).getItem(`cr_token:${A}`)).toBeNull()
  })
})
