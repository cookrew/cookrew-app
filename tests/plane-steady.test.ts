// THE NETWORK THAT STAYS UP ACROSS A SWITCH (2026-10-18, "relay → tailnet,
// then no network"): a stream that looks open and is not, a switch that tore the old
// stream down before the new one existed, a transcript that never followed
// the plane, and a stream waiting out its backoff while requests already work.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { watchStream, STREAM_OPEN_MS, STREAM_SILENT_MS, type WatchableSource } from '../src/renderer/src/stream-watch'
import { ReconnectingStream, STREAM_CLOSED, STREAM_OPEN, type EventStreamLike } from '../src/renderer/src/live-stream'
import { registerPlaneStream, resetPlaneStreams, reviveStreams } from '../src/renderer/src/plane-streams'
import { SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_MS } from '../src/main/mobile-http'

class FakeSource extends EventTarget implements WatchableSource, EventStreamLike {
  readyState = 0
  onerror: ((event: Event) => void) | null = null
  closed = false
  close(): void {
    this.closed = true
    this.readyState = STREAM_CLOSED
  }
  open(): void {
    this.readyState = STREAM_OPEN
    this.dispatchEvent(new Event('open'))
  }
  send(type: string, data = '{}'): void {
    this.dispatchEvent(new MessageEvent(type, { data }))
  }
  die(): void {
    this.readyState = STREAM_CLOSED
    this.dispatchEvent(new Event('error'))
  }
}

afterEach(() => {
  vi.useRealTimers()
  resetPlaneStreams()
})

describe('a stream that looks open and is not', () => {
  it('is killed when it never opens — a connect into a dead path', () => {
    vi.useFakeTimers()
    const source = watchStream(new FakeSource(), { native: false })
    const seen: string[] = []
    source.onerror = () => void seen.push(`onerror:${source.readyState}`)
    source.addEventListener('error', () => void seen.push('error'))
    vi.advanceTimersByTime(STREAM_OPEN_MS)
    expect(source.closed).toBe(true)
    expect(seen).toEqual(['error', 'onerror:2'])
  })

  it('is killed when it goes silent after it has beaten — Tailscale dropped under it', () => {
    vi.useFakeTimers()
    const source = watchStream(new FakeSource(), { native: false })
    source.open()
    source.send('hb', '1')
    vi.advanceTimersByTime(STREAM_SILENT_MS - 1)
    source.send('hb', '1')
    vi.advanceTimersByTime(STREAM_SILENT_MS - 1)
    expect(source.closed).toBe(false)
    vi.advanceTimersByTime(2)
    expect(source.closed).toBe(true)
  })

  it('is never killed for silence by a Mac too old to beat', () => {
    vi.useFakeTimers()
    const source = watchStream(new FakeSource(), { native: false })
    source.open()
    vi.advanceTimersByTime(STREAM_SILENT_MS * 10)
    expect(source.closed).toBe(false)
  })

  it('stops watching once closed by its owner', () => {
    vi.useFakeTimers()
    const source = watchStream(new FakeSource(), { native: false })
    let errors = 0
    source.addEventListener('error', () => void (errors += 1))
    source.close()
    vi.advanceTimersByTime(STREAM_OPEN_MS * 2)
    expect(errors).toBe(0)
  })

  it('beats often enough on the Mac for the silence to mean something', () => {
    expect(SSE_HEARTBEAT_FRAME).toBe('event: hb\ndata: 1\n\n')
    expect(STREAM_SILENT_MS).toBeGreaterThanOrEqual(2 * SSE_HEARTBEAT_MS)
    expect(STREAM_SILENT_MS).toBeLessThanOrEqual(3 * SSE_HEARTBEAT_MS)
  })
})

describe('a switch makes before it breaks', () => {
  const rig = (): { stream: ReconnectingStream; sources: FakeSource[]; seen: string[]; failed: () => number; run: () => void } => {
    const sources: FakeSource[] = []
    const queue: (() => void)[] = []
    let failed = 0
    const stream = new ReconnectingStream({
      open: () => {
        const s = new FakeSource()
        sources.push(s)
        return s
      },
      schedule: (run) => void queue.push(run),
      cancel: () => undefined,
      backoffMs: [10],
      onSwitchFailed: () => void (failed += 1)
    })
    const seen: string[] = []
    stream.on('workspace', (e) => void seen.push(String(e.data)))
    sources[0].open()
    return { stream, sources, seen, failed: () => failed, run: () => queue.splice(0).forEach((f) => f()) }
  }

  it('keeps the old stream carrying events until the new one opens', () => {
    const { stream, sources, seen } = rig()
    stream.restart()
    expect(sources).toHaveLength(2)
    expect(sources[0].closed).toBe(false)
    sources[0].send('workspace', 'old')
    sources[1].open()
    expect(sources[0].closed).toBe(true)
    sources[1].send('workspace', 'new')
    sources[0].send('workspace', 'late')
    expect(seen).toEqual(['old', 'new'])
  })

  it('keeps the old stream when the new plane will not open, says so, and tries again', () => {
    const { stream, sources, seen, failed, run } = rig()
    stream.restart()
    sources[1].die()
    expect(failed()).toBe(1)
    expect(sources[0].closed).toBe(false)
    sources[0].send('workspace', 'still')
    run()
    expect(sources).toHaveLength(3)
    sources[2].open()
    expect(sources[0].closed).toBe(true)
    expect(seen).toEqual(['still'])
  })

  it('just connects when the old stream is already dead', () => {
    const { stream, sources } = rig()
    sources[0].die()
    stream.restart()
    expect(sources[0].closed).toBe(true)
    expect(sources).toHaveLength(2)
  })
})

describe('a request that works revives a stream that is waiting', () => {
  it('asks every registered stream, at most once per two seconds', () => {
    let revived = 0
    registerPlaneStream({ restart: () => undefined, revive: () => void (revived += 1) })
    registerPlaneStream({ restart: () => undefined })
    reviveStreams(10_000)
    reviveStreams(10_500)
    reviveStreams(12_001)
    expect(revived).toBe(2)
  })
})

describe('the transcript follows the plane', () => {
  it('registers its live stream to restart on a switch and revive on evidence', () => {
    const src = readFileSync('src/renderer/src/stream/stream-http.ts', 'utf8')
    expect(src).toContain('registerPlaneStream({')
    expect(src).toMatch(/restart: reopen/)
  })
})
