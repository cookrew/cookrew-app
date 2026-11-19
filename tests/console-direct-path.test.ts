import { afterEach, describe, expect, it, vi } from 'vitest'
import { inConsole, relayBaseFor, unfoldRelay } from './support/console-scope'

/**
 * THE CONSOLE KNOWS NO NAMES (2026-11-16). A machine is entered over the relay,
 * which always works, and the only nearer path is the WebRTC link the page
 * knocks open itself (path/rtc-adopt.ts). The per-machine names under
 * d.cookrew.dev are gone from the page: it never reads the machine's reach
 * card for them, never asks the registry's zone or its verify route about
 * one, and never sends a single request to one, even when everything about a
 * name would have answered.
 */

const M = '11111111-2222-4333-8444-555555555555'
const BASE = relayBaseFor(M)
const API = 'https://api.cookrew.dev'
const NAME = `https://192-168-1-24.${M}.d.cookrew.dev:8643`

interface Sent {
  url: string
  init: RequestInit
}

function page(): { sent: Sent[] } {
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
    // Everything a name would have needed answers as if the name were real.
    if (url.startsWith(`${BASE}/api/reach`)) return json({ deviceId: M, lan: [{ url: 'https://192.168.1.24:8643' }], tailnet: null, trusted: [NAME] })
    if (url.startsWith(`${NAME}/api/hello`)) {
      const nonce = new URL(url).searchParams.get('nonce')
      return json({ v: 2, deviceId: M, origin: NAME, issuedAtMs: Date.now(), nonce, sig: 'a-signature' })
    }
    if (url === `${API}/v2/verify-hello`) return json({ ok: true })
    if (url.startsWith(`${API}/v2/names/`)) return json({ live: true })
    // Streams and everything else: never answered here.
    return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
  })
  return { sent }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as { window?: unknown }).window
  vi.resetModules()
})

describe('inside a machine on the console', () => {
  it('asks nothing about a name: no reach card, no hello, no zone, no verify, no d.cookrew.dev host', async () => {
    const { sent } = page()
    vi.resetModules()
    const scope = await inConsole(M)
    const plane = await import('../src/renderer/src/data-plane')
    const session = await import('../src/renderer/src/machine-session')
    const base = await import('../src/renderer/src/api-base')
    session.startMachineSession()
    await pause(80)
    // The page did talk to the machine (over the relay), so silence below is not a page that never started.
    expect(sent.some((one) => one.url.startsWith(BASE))).toBe(true)
    for (const one of sent) {
      expect(one.url, one.url).not.toContain('d.cookrew.dev')
      expect(one.url, one.url).not.toContain('/v2/names')
      expect(one.url, one.url).not.toContain('/v2/verify-hello')
      expect(one.url, one.url).not.toContain('/api/reach')
      expect(one.url, one.url).not.toContain('/api/hello')
    }
    // And it stays where it entered: the relay, with requests under the relay's prefix.
    expect(plane.dataPlane()).toEqual({ origin: '', kind: 'relay' })
    expect(base.apiPath('/api/workspace')).not.toContain('d.cookrew.dev')
    scope.enterMachine(null)
  })
})
