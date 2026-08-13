import { describe, expect, it, vi } from 'vitest'
import {
  ReconnectingStream,
  STREAM_CLOSED,
  STREAM_CONNECTING,
  STREAM_OPEN
} from '../src/renderer/src/live-stream'

/** A stand-in for EventSource whose readyState the test drives. */
class FakeSource {
  readyState = STREAM_OPEN
  closed = false
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: MessageEvent) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data ?? {}) } as MessageEvent)
    }
  }

  /** The stream died for good — the state a reload used to be needed for. */
  die(): void {
    this.readyState = STREAM_CLOSED
    this.emit('error')
  }
}

/** Deterministic timers: a queue the test drains when it chooses. */
function timers(): {
  schedule: (run: () => void, ms: number) => unknown
  cancel: (handle: unknown) => void
  run: () => void
  delays: number[]
  pending: () => number
} {
  const queue = new Map<number, () => void>()
  const delays: number[] = []
  let next = 1
  return {
    schedule: (run, ms) => {
      delays.push(ms)
      const id = next++
      queue.set(id, run)
      return id
    },
    cancel: (handle) => void queue.delete(handle as number),
    run: () => {
      const entries = [...queue.entries()]
      queue.clear()
      for (const [, run] of entries) run()
    },
    delays,
    pending: () => queue.size
  }
}

function harness(): {
  stream: ReconnectingStream
  sources: FakeSource[]
  clock: ReturnType<typeof timers>
} {
  const sources: FakeSource[] = []
  const clock = timers()
  const stream = new ReconnectingStream({
    open: () => {
      const source = new FakeSource()
      sources.push(source)
      return source
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
    backoffMs: [10, 20, 40]
  })
  return { stream, sources, clock }
}

describe('ReconnectingStream', () => {
  it('delivers events to a subscriber', () => {
    const { stream, sources } = harness()
    const seen: unknown[] = []
    stream.on('workspace', (e) => seen.push(JSON.parse(e.data)))
    sources[0].emit('workspace', { name: 'Portfolio' })
    expect(seen).toEqual([{ name: 'Portfolio' }])
  })

  it('reconnects after the stream dies, and the subscriber keeps receiving', () => {
    const { stream, sources, clock } = harness()
    const seen: unknown[] = []
    stream.on('workspace', (e) => seen.push(JSON.parse(e.data)))

    sources[0].die()
    expect(sources).toHaveLength(1) // waiting out the backoff
    clock.run()

    expect(sources).toHaveLength(2)
    sources[1].emit('workspace', { name: 'Portfolio' })
    expect(seen).toEqual([{ name: 'Portfolio' }])
  })

  it('leaves the browser alone while IT is retrying', () => {
    const { stream, sources, clock } = harness()
    stream.on('workspace', () => undefined)
    sources[0].readyState = STREAM_CONNECTING
    sources[0].emit('error')
    clock.run()
    expect(sources).toHaveLength(1)
  })

  it('backs off further on each successive failure', () => {
    const { stream, sources, clock } = harness()
    stream.on('workspace', () => undefined)
    for (let i = 0; i < 4; i += 1) {
      sources[sources.length - 1].die()
      clock.run()
    }
    // Last delay repeats once the ladder runs out.
    expect(clock.delays).toEqual([10, 20, 40, 40])
  })

  it('resets the backoff once a connection opens', () => {
    const { stream, sources, clock } = harness()
    stream.on('workspace', () => undefined)
    sources[0].die()
    clock.run()
    sources[1].emit('open')
    sources[1].die()
    clock.run()
    expect(clock.delays).toEqual([10, 10])
  })

  it('revives a dead stream immediately — the refresh button', () => {
    const { stream, sources, clock } = harness()
    stream.on('workspace', () => undefined)
    sources[0].readyState = STREAM_CLOSED

    stream.revive()

    expect(sources).toHaveLength(2)
    expect(clock.pending()).toBe(0) // the queued retry was dropped, not doubled
    sources[1].readyState = STREAM_OPEN
    const seen: unknown[] = []
    stream.on('workspaces', (e) => seen.push(JSON.parse(e.data)))
    sources[1].emit('workspaces', { activeId: 'ws-1' })
    expect(seen).toEqual([{ activeId: 'ws-1' }])
  })

  it('leaves a healthy stream connected when revived', () => {
    const { stream, sources } = harness()
    stream.on('workspace', () => undefined)
    stream.revive()
    expect(sources).toHaveLength(1)
    expect(sources[0].closed).toBe(false)
  })

  it('drops a pending retry when reviving, rather than opening two streams', () => {
    const { stream, sources, clock } = harness()
    stream.on('workspace', () => undefined)
    sources[0].die()
    stream.revive()
    clock.run()
    expect(sources).toHaveLength(2)
  })

  it('stops delivering to an unsubscribed listener, across reconnects', () => {
    const { stream, sources, clock } = harness()
    const seen: unknown[] = []
    const off = stream.on('workspace', (e) => seen.push(JSON.parse(e.data)))
    off()
    sources[0].die()
    clock.run()
    sources[1].emit('workspace', { name: 'Portfolio' })
    expect(seen).toEqual([])
  })

  it('closes for good — no reconnect after close()', () => {
    const { stream, sources, clock } = harness()
    stream.on('workspace', () => undefined)
    stream.close()
    expect(sources[0].closed).toBe(true)
    sources[0].die()
    clock.run()
    expect(sources).toHaveLength(1)
    stream.revive()
    expect(sources).toHaveLength(1)
  })

  it('opens exactly one stream for many subscribers', () => {
    const { stream, sources } = harness()
    stream.on('workspace', () => undefined)
    stream.on('workspaces', () => undefined)
    stream.on('activity', () => undefined)
    expect(sources).toHaveLength(1)
  })

  it('reports whether the link is up', () => {
    const { stream, sources } = harness()
    stream.on('workspace', () => undefined)
    expect(stream.alive).toBe(true)
    sources[0].readyState = STREAM_CLOSED
    expect(stream.alive).toBe(false)
  })

  it('closes the old source when it reconnects', () => {
    const { stream, sources, clock } = harness()
    stream.on('workspace', () => undefined)
    sources[0].die()
    clock.run()
    expect(sources[0].closed).toBe(true)
  })

  it('does not double-deliver after a reconnect', () => {
    const { stream, sources, clock } = harness()
    const seen = vi.fn()
    stream.on('workspace', seen)
    sources[0].die()
    clock.run()
    sources[1].emit('workspace', { name: 'Portfolio' })
    expect(seen).toHaveBeenCalledTimes(1)
  })
})
