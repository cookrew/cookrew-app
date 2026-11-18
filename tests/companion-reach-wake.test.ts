// THE PHONE KNOCKS THE MOMENT THE MAC SAYS ITS ADDRESSES MOVED.
//
// A companion on the relay plane races on its own sixty second clock, on
// `online`, and on a tab coming back, and a race knocks the WebRTC link open
// at most once every two minutes. None of those is the moment a Mac woke on a
// different Wi-Fi: the phone sat still on RELAY. The Mac pushes `reach` on
// the event stream when its addresses change, and the companion treats that
// push like a new network: the knock is owed now, not after the gap. (It used
// to re-race the Mac's names; those are gone, 2026-11-16.)

import { afterEach, describe, expect, it, vi } from 'vitest'
import { inConsole, relayBaseFor, unfoldRelay } from './support/console-scope'

const DEVICE = '11111111-2222-3333-4444-555555555555'
/** The machine's address on the relay, as the console reaches it. */
const RELAY_BASE = relayBaseFor(DEVICE)

type Listener = (event: unknown) => void

/** A phone with a stream: the one `/api/events` EventSource the page holds. */
const stubPhone = () => {
  const streams: Map<string, Set<Listener>>[] = []
  const asked: string[] = []
  class FakeEventSource {
    readonly listeners = new Map<string, Set<Listener>>()
    readyState = 1
    constructor() {
      streams.push(this.listeners)
    }
    addEventListener(type: string, listener: Listener): void {
      const set = this.listeners.get(type) ?? new Set<Listener>()
      set.add(listener)
      this.listeners.set(type, set)
    }
    removeEventListener(type: string, listener: Listener): void {
      this.listeners.get(type)?.delete(listener)
    }
    close(): void {
      this.readyState = 2
    }
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    COOKREW_MOBILE: 1,
    location: { origin: 'https://cookrew.dev', search: '', hash: '', replace: () => undefined, assign: () => undefined },
    localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    history: { replaceState: () => undefined },
    crypto: { getRandomValues: (bytes: Uint8Array) => bytes },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined
  }
  Object.assign(globalThis, { EventSource: FakeEventSource })
  // On the relay a stream goes by fetch, so its bearer can ride a header.
  let live: ReadableStreamDefaultController<Uint8Array> | null = null
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
    // Read as the path it names: a relayed call leaves at the relay's one address (latency 0.6.1).
    if (unfoldRelay(String(url), init).includes('/api/events')) {
      return new Response(new ReadableStream({ start: (controller) => void (live = controller) }), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      })
    }
    asked.push(unfoldRelay(String(url), init))
    throw new Error('unreachable')
  }
  return {
    asked: () => asked,
    push: (type: string, data: unknown) => {
      live?.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
      for (const stream of streams) for (const listener of stream.get(type) ?? []) listener({ data: JSON.stringify(data) })
    },
    listening: () => live !== null
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Every knock the companion makes, counted where the link would be dialled. */
const countKnocks = (): { readonly knocks: () => number } => {
  let knocks = 0
  vi.doMock('../src/renderer/src/path/rtc-link', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../src/renderer/src/path/rtc-link')>()),
    connectRtcLink: async () => {
      knocks += 1
      return null
    }
  }))
  // A browser that has WebRTC at all; the dial itself is the mock above.
  vi.stubGlobal('RTCPeerConnection', function RTCPeerConnection() {})
  return { knocks: () => knocks }
}

afterEach(() => {
  delete (globalThis as { fetch?: unknown }).fetch
  delete (globalThis as { EventSource?: unknown }).EventSource
  vi.doUnmock('../src/renderer/src/path/rtc-link')
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('a reach push from the Mac', () => {
  it('knocks at once, past the two-minute gap, and asks the Mac for no card', async () => {
    const phone = stubPhone()
    vi.resetModules()
    const { knocks } = countKnocks()
    await inConsole(DEVICE)
    const companion = await import('../src/renderer/src/path/companion')
    const stop = companion.startCompanionPathSwitch()
    await vi.waitFor(() => expect(phone.listening()).toBe(true))
    // The boot race knocked once and reported it; the gap now holds the next knock back.
    await vi.waitFor(() => expect(phone.asked().some((url) => url.includes('/api/path/report'))).toBe(true))
    expect(knocks()).toBe(1)

    phone.push('reach', { at: 1 })
    await vi.waitFor(() => expect(knocks()).toBe(2))
    // Nothing asked where else the Mac lives: the card fed only the names.
    expect(phone.asked().filter((url) => url.includes('/api/reach'))).toEqual([])

    stop()
    // Stopped means stopped: a later push knocks nothing.
    phone.push('reach', { at: 2 })
    await settle()
    await settle()
    expect(knocks()).toBe(2)
  })
})
