// THE PHONE RACES THE MOMENT THE MAC SAYS ITS ADDRESSES MOVED.
//
// A companion on the relay plane re-races the Mac's names on its own sixty
// second clock, on `online`, and on a tab coming back. None of those is the
// moment a Mac woke on a different Wi-Fi: the phone sat still, the badge said
// RELAY, and the sheet said "your Mac is not on this network" about a Mac on
// the same desk — until a restart of the desktop published a card and the
// phone happened to look. The Mac now pushes `reach` on the event stream once
// the registry has taken a card that differs, and the companion treats that
// push like a press of TRY AGAIN: the same race, now, with no prompt.

import { afterEach, describe, expect, it, vi } from 'vitest'

const DEVICE = '11111111-2222-3333-4444-555555555555'
const RELAY_BASE = `/relay/@owner/desktop/${DEVICE}`

type Listener = (event: unknown) => void

/** A phone with a stream: the one `/api/events` EventSource the page holds. */
const stubPhone = () => {
  const streams: Map<string, Set<Listener>>[] = []
  let fetched = 0
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
  ;(globalThis as unknown as { fetch: unknown }).fetch = async (): Promise<never> => {
    fetched += 1
    throw new Error('unreachable')
  }
  return {
    fetched: () => fetched,
    push: (type: string, data: unknown) => {
      for (const stream of streams) for (const listener of stream.get(type) ?? []) listener({ data: JSON.stringify(data) })
    },
    listening: (type: string) => streams.some((stream) => (stream.get(type)?.size ?? 0) > 0)
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  delete (globalThis as { COOKREW_BASE?: unknown }).COOKREW_BASE
  delete (globalThis as { fetch?: unknown }).fetch
  delete (globalThis as { EventSource?: unknown }).EventSource
  vi.resetModules()
})

describe('a reach push from the Mac', () => {
  it('starts a race at once, and the race is the switcher’s own (one at a time, no prompt)', async () => {
    const phone = stubPhone()
    Object.assign(globalThis, { COOKREW_BASE: RELAY_BASE })
    vi.resetModules()
    const companion = await import('../src/renderer/src/path/companion')
    const stop = companion.startCompanionPathSwitch()
    await settle()
    expect(phone.listening('reach')).toBe(true)
    const before = phone.fetched()
    expect(before).toBeGreaterThan(0)

    phone.push('reach', { at: 1 })
    await settle()
    // The push looked for the Mac again: a fresh /api/reach, which is the
    // first request a race makes. The stub refuses it, so nothing moved.
    expect(phone.fetched()).toBeGreaterThan(before)
    stop()
    // Stopped means stopped: a later push races nothing.
    const after = phone.fetched()
    phone.push('reach', { at: 2 })
    await settle()
    expect(phone.fetched()).toBe(after)
  })
})
