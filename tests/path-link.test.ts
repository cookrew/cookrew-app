import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReconnectingStream, type EventStreamLike } from '../src/renderer/src/live-stream'
import {
  currentPathBadge,
  pathLinkState,
  recordLatency,
  resetPathLink,
  setDesktopName,
  setPathLink,
  subscribePathLink
} from '../src/renderer/src/path-link'

const stubWindow = (origin: string): void => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    location: { origin }
  }
}

beforeEach(() => {
  resetPathLink()
  stubWindow('https://192.168.1.24:8643')
})
afterEach(() => resetPathLink())

describe('the companion link store', () => {
  it('starts live and tells subscribers when it changes', () => {
    const seen: string[] = []
    subscribePathLink((next) => seen.push(next.link))
    expect(pathLinkState().link).toBe('live')
    setPathLink('reconnecting')
    setPathLink('failed')
    expect(seen).toEqual(['reconnecting', 'failed'])
  })

  it('does not wake subscribers for a state it is already in', () => {
    let calls = 0
    subscribePathLink(() => calls++)
    setPathLink('live')
    expect(calls).toBe(0)
  })

  it('unsubscribes', () => {
    let calls = 0
    const off = subscribePathLink(() => calls++)
    off()
    setPathLink('failed')
    expect(calls).toBe(0)
  })

  it('smooths latency, so one slow request is not the network', () => {
    recordLatency(100)
    expect(pathLinkState().latencyMs).toBe(100)
    recordLatency(1000)
    // 100 * 0.7 + 1000 * 0.3 — moved, but nowhere near the spike.
    expect(pathLinkState().latencyMs).toBe(370)
  })

  it('ignores a nonsense measurement', () => {
    recordLatency(50)
    recordLatency(Number.NaN)
    recordLatency(-1)
    expect(pathLinkState().latencyMs).toBe(50)
  })

  it('builds the badge from the page own origin', () => {
    setDesktopName('MacBook Pro')
    const view = currentPathBadge()
    expect(view.state).toBe('LAN')
    expect(view.desktopName).toBe('MacBook Pro')
  })

  it('follows the origin the page was actually served from', () => {
    stubWindow('https://mac.tail9.ts.net:8643')
    expect(currentPathBadge().state).toBe('TAILNET')
    stubWindow('https://cookrew.dev')
    expect(currentPathBadge().state).toBe('RELAY')
  })
})

describe('the stream reports its own health', () => {
  /** An EventSource stand-in the test drives by hand. */
  const fakeSource = () => {
    const listeners = new Map<string, Set<(event: MessageEvent) => void>>()
    let readyState = 0
    const source: EventStreamLike = {
      addEventListener: (type, listener) => {
        const set = listeners.get(type) ?? new Set()
        set.add(listener)
        listeners.set(type, set)
      },
      removeEventListener: (type, listener) => void listeners.get(type)?.delete(listener),
      close: () => undefined,
      get readyState() {
        return readyState
      }
    }
    return {
      source,
      fire: (type: string) =>
        listeners.get(type)?.forEach((l) => l({} as MessageEvent)),
      setState: (next: number) => void (readyState = next)
    }
  }

  it('says live when a connection opens and probing when it drops', () => {
    const seen: string[] = []
    const fake = fakeSource()
    const stream = new ReconnectingStream({
      open: () => fake.source,
      onState: (state) => seen.push(state),
      schedule: () => 0,
      cancel: () => undefined
    })
    stream.on('workspace', () => undefined)
    fake.fire('open')
    fake.setState(2)
    fake.fire('error')
    expect(seen).toEqual(['live', 'reconnecting'])
  })

  it('says failed once the backoff has been walked to its end', () => {
    const seen: string[] = []
    const fake = fakeSource()
    // The retry is only spent once its timer actually fires, so the pending
    // run is drained by hand rather than run inside `schedule` — doing it
    // there re-enters reconnect() before `timer` is assigned and the backoff
    // never advances.
    const pending: (() => void)[] = []
    const stream = new ReconnectingStream({
      open: () => fake.source,
      onState: (state) => seen.push(state),
      backoffMs: [1, 2],
      schedule: (run) => {
        pending.push(run)
        return 1
      },
      cancel: () => undefined
    })
    stream.on('workspace', () => undefined)
    fake.setState(2)
    for (let i = 0; i < 3; i++) {
      fake.fire('error')
      pending.shift()?.()
    }
    expect(seen).toEqual(['reconnecting', 'reconnecting', 'failed'])
  })

  it('says nothing at all when nobody asked to be told', () => {
    const fake = fakeSource()
    const stream = new ReconnectingStream({ open: () => fake.source })
    stream.on('workspace', () => undefined)
    expect(() => fake.fire('open')).not.toThrow()
  })
})
