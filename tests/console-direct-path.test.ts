import { afterEach, describe, expect, it, vi } from 'vitest'
import { inConsole, relayBaseFor, unfoldRelay } from './support/console-scope'

/**
 * THE CONSOLE FINDS THE NEARER PATH BY ITSELF (0.6.0, decision F2). A machine
 * is entered over the relay, which always works. In the background the page
 * asks that machine where else it lives, knocks on its own name on this
 * network, has the registry confirm the answer came from that machine, and
 * only then moves its requests there. The address bar never changes, and the
 * account's session never goes to the machine's own address.
 */

const M = '11111111-2222-4333-8444-555555555555'
const BASE = relayBaseFor(M)
const API = 'https://api.cookrew.dev'
const LAN = `https://192-168-1-24.${M}.d.cookrew.dev:8643`

interface Sent {
  url: string
  init: RequestInit
}

function page(answers: { verify?: unknown; cardDevice?: string } = {}): { sent: Sent[] } {
  const sent: Sent[] = []
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    location: { origin: 'https://console.cookrew.dev', search: '', hash: '', href: 'https://console.cookrew.dev/', replace: () => undefined, assign: () => undefined },
    localStorage: { getItem: (key: string) => (key === `cr_token:${M}` ? 'machine-token' : null), setItem: () => undefined, removeItem: () => undefined },
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    history: { replaceState: () => undefined },
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes },
    addEventListener: () => undefined,
    removeEventListener: () => undefined
  }
  vi.stubGlobal('document', { hidden: false, visibilityState: 'visible', addEventListener: () => undefined, removeEventListener: () => undefined })
  vi.stubGlobal('fetch', async (input: string, init: RequestInit = {}) => {
    const url = unfoldRelay(String(input), init)
    sent.push({ url, init })
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url.startsWith(`${BASE}/api/reach`)) return json({ deviceId: answers.cardDevice ?? M, lan: [{ url: 'https://192.168.1.24:8643' }], tailnet: null, trusted: [LAN] })
    if (url.startsWith(`${LAN}/api/hello`)) {
      const nonce = new URL(url).searchParams.get('nonce')
      return json({ v: 2, deviceId: M, origin: LAN, issuedAtMs: Date.now(), nonce, sig: 'a-signature' })
    }
    if (url === `${API}/v2/verify-hello`) return json(answers.verify ?? { ok: true })
    if (url.startsWith(`${API}/v2/names/`)) return json({ live: true })
    // Streams and everything else: never answered here.
    return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  })
  return { sent }
}

const settled = async (check: () => boolean): Promise<void> => {
  for (let turn = 0; turn < 200 && !check(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 5))
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { window?: unknown }).window
  vi.resetModules()
})

describe('inside a machine on the console', () => {
  it('moves its requests onto the machine’s own name once the registry says the answer was that machine’s', async () => {
    const { sent } = page()
    vi.resetModules()
    const scope = await inConsole(M)
    const plane = await import('../src/renderer/src/data-plane')
    const session = await import('../src/renderer/src/machine-session')
    const base = await import('../src/renderer/src/api-base')
    session.startMachineSession()
    await settled(() => plane.dataPlane().kind === 'lan')
    expect(plane.dataPlane()).toMatchObject({ origin: LAN, kind: 'lan' })
    // From now on a request is built for the machine's own name, without the relay's prefix.
    expect(base.apiPath('/api/workspace')).toBe(`${LAN}/api/workspace`)

    // The card was read through the relay, with the machine's token and the account session.
    const card = sent.find((one) => one.url.startsWith(`${BASE}/api/reach`))
    expect(new Headers(card?.init.headers).get('authorization')).toBe('Bearer machine-token')
    expect(new Headers(card?.init.headers).get('x-cookrew-session')).toBe('account-session')
    // The knock carried no credential at all.
    const knock = sent.find((one) => one.url.startsWith(`${LAN}/api/hello`))
    expect(new Headers(knock?.init.headers).get('authorization')).toBeNull()
    expect(new Headers(knock?.init.headers).get('x-cookrew-session')).toBeNull()
    // The registry was asked at its API host, with the session as a bearer.
    const verify = sent.find((one) => one.url === `${API}/v2/verify-hello`)
    expect(new Headers(verify?.init.headers).get('authorization')).toBe('Bearer account-session')
    // And nothing sent to the machine's own name ever carried the account's session.
    for (const one of sent.filter((each) => each.url.startsWith(LAN))) expect(new Headers(one.init.headers).get('x-cookrew-session'), one.url).toBeNull()

    // Leaving the machine goes back to the relay: the next one starts on the path that is known to work.
    scope.enterMachine(null)
    expect(plane.dataPlane()).toEqual({ origin: '', kind: 'relay' })
  })

  it('stays on the relay when the registry does not confirm the answer', async () => {
    const { sent } = page({ verify: { ok: false, reason: 'bad_signature' } })
    vi.resetModules()
    const scope = await inConsole(M)
    const plane = await import('../src/renderer/src/data-plane')
    const session = await import('../src/renderer/src/machine-session')
    session.startMachineSession()
    await settled(() => sent.some((one) => one.url === `${API}/v2/verify-hello`))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(plane.dataPlane()).toEqual({ origin: '', kind: 'relay' })
    scope.enterMachine(null)
  })

  it('knocks nowhere on a card that names another machine: the card is not this machine’s', async () => {
    const { sent } = page({ cardDevice: '99999999-9999-4999-8999-999999999999' })
    vi.resetModules()
    const scope = await inConsole(M)
    const plane = await import('../src/renderer/src/data-plane')
    const session = await import('../src/renderer/src/machine-session')
    session.startMachineSession()
    await settled(() => sent.some((one) => one.url.startsWith(`${BASE}/api/reach`)))
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(sent.some((one) => one.url.includes('/api/hello'))).toBe(false)
    expect(plane.dataPlane()).toEqual({ origin: '', kind: 'relay' })
    scope.enterMachine(null)
  })
})
