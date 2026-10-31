// The phone beacon counts every SSE message by wrapping EventSource. Its first
// wrapper gave each listener a fresh closure, so removeEventListener never
// matched and a re-added listener was never deduplicated: React StrictMode's
// mount/unmount/mount left two toast subscriptions on the companion, and every
// single event toasted as "2 …" (status eval r2/r3, measured 11-01).

import { describe, expect, it } from 'vitest'
import { tapEventSource } from '../src/renderer/src/sse-tap'

class FakeSource extends EventTarget {
  constructor(public url: string) {
    super()
  }
  push(type: string, data: string): void {
    this.dispatchEvent(new MessageEvent(type, { data }))
  }
}

function tapped(): { source: FakeSource; seen: string[] } {
  const seen: string[] = []
  const Tapped = tapEventSource(FakeSource as unknown as typeof EventSource, (data) => seen.push(data))
  const source = new Tapped('https://x/api/events') as unknown as FakeSource
  return { source, seen }
}

describe('tapEventSource', () => {
  it('counts each message once and hands it to the listener', () => {
    const { source, seen } = tapped()
    const got: string[] = []
    source.addEventListener('event', (e) => got.push((e as MessageEvent).data))
    source.push('event', 'a')
    expect(got).toEqual(['a'])
    expect(seen).toEqual(['a'])
  })

  it('a removed listener hears nothing more', () => {
    const { source } = tapped()
    const got: string[] = []
    const listener = (e: Event): void => void got.push((e as MessageEvent).data)
    source.addEventListener('event', listener)
    source.removeEventListener('event', listener)
    source.push('event', 'a')
    expect(got).toEqual([])
  })

  it('adding the same listener twice still delivers once, like a real EventTarget', () => {
    const { source } = tapped()
    const got: string[] = []
    const listener = (e: Event): void => void got.push((e as MessageEvent).data)
    source.addEventListener('event', listener)
    source.addEventListener('event', listener)
    source.push('event', 'a')
    expect(got).toEqual(['a'])
  })

  it('subscribe, unsubscribe, subscribe (StrictMode) leaves one delivery per event', () => {
    const { source } = tapped()
    const got: string[] = []
    const first = (e: Event): void => void got.push((e as MessageEvent).data)
    source.addEventListener('event', first)
    source.removeEventListener('event', first)
    const second = (e: Event): void => void got.push((e as MessageEvent).data)
    source.addEventListener('event', second)
    source.push('event', 'a')
    expect(got).toEqual(['a'])
  })

  it('the same function on two types is two listeners, each removable', () => {
    const { source } = tapped()
    const got: string[] = []
    const listener = (e: Event): void => void got.push(`${e.type}:${(e as MessageEvent).data}`)
    source.addEventListener('event', listener)
    source.addEventListener('hb', listener)
    source.removeEventListener('event', listener)
    source.push('event', 'a')
    source.push('hb', 'b')
    expect(got).toEqual(['hb:b'])
  })

  it('keeps instanceof working for code that checks the real class', () => {
    const Tapped = tapEventSource(FakeSource as unknown as typeof EventSource, () => undefined)
    expect(new Tapped('u')).toBeInstanceOf(FakeSource)
  })
})
