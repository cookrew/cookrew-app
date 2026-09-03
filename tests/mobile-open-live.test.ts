import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  attachTerminalStream,
  STREAM_CLOSED,
  STREAM_OPEN
} from '../src/renderer/src/live-stream'
import { shouldStick } from '../src/renderer/src/transcript'

const src = (file: string): string =>
  readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', file), 'utf8')

/** Slice between two markers, refusing to fail open if either moves. */
const between = (text: string, from: string, to: string): string => {
  const start = text.indexOf(from)
  expect(start, from).toBeGreaterThan(-1)
  const end = text.indexOf(to, start)
  expect(end, to).toBeGreaterThan(-1)
  return text.slice(start, end)
}

/** The same stand-in EventSource live-stream.test.ts drives. */
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
  die(): void {
    this.readyState = STREAM_CLOSED
    this.emit('error')
  }
}

describe('first open of a terminal on the phone', () => {
  /**
   * Three mobile-only failures, one report (2026-09-03): the first tap showed
   * a black live pane, the second landed mid-history, and only a LIVE tap
   * recovered. Desktop never sees any of them — its preload retries a cold
   * pty:attach, its engine implements scroll anchoring, and it lays out real
   * block heights. These pin the phone-side counterweights.
   */

  it('the terminal stream survives the cold-mirror 404 a bare EventSource dies on', () => {
    // preload/index.ts retries pty:attach for exactly this ("left the live
    // pane BLACK forever"). The remote transport's version of that refusal is
    // an HTTP 404 on the stream URL — fatal to EventSource, which never
    // browser-retries a non-2xx.
    const sources: FakeSource[] = []
    const queue: Array<() => void> = []
    const frames: string[] = []
    let hello: { cols: number; rows: number } | null = null
    const stream = attachTerminalStream(
      {
        open: () => {
          const source = new FakeSource()
          sources.push(source)
          return source
        },
        schedule: (run) => {
          queue.push(run)
          return queue.length
        },
        cancel: () => undefined
      },
      (chunk) => frames.push(chunk),
      (size) => {
        hello = size
      }
    )
    // The mirror is cold: the first connection dies the way a 404 kills it.
    sources[0].die()
    expect(queue.length).toBe(1)
    queue.shift()?.()
    // The retry connects; the server replays hello + a fresh frame.
    expect(sources.length).toBe(2)
    sources[1].emit('hello', { cols: 80, rows: 24 })
    sources[1].emit('data', 'the frame')
    expect(hello).toEqual({ cols: 80, rows: 24 })
    expect(frames).toEqual(['the frame'])
    stream.close()
  })

  it('a session that is GONE is not a session to keep dialling', () => {
    // The stream retries forever by design (the phone link genuinely flaps),
    // so the server's exit event must be its one true stop.
    const sources: FakeSource[] = []
    const queue: Array<() => void> = []
    attachTerminalStream(
      {
        open: () => {
          const source = new FakeSource()
          sources.push(source)
          return source
        },
        schedule: (run) => {
          queue.push(run)
          return queue.length
        },
        cancel: () => undefined
      },
      () => undefined
    )
    sources[0].emit('exit')
    expect(sources[0].closed).toBe(true)
    sources[0].die()
    expect(queue.length).toBe(0)
  })

  it('the pin re-sticks on growth, with the same slack the pin itself uses', () => {
    // WebKit implements no scroll anchoring, and content-visibility makes
    // scrollHeight an 88px-per-block estimate at write time — every
    // scrollTop = scrollHeight landed short and nothing corrected it.
    expect(shouldStick(true, 0, 2000, 800)).toBe(true)
    // Unpinned reading is never yanked, however large the gap.
    expect(shouldStick(false, 0, 2000, 800)).toBe(false)
    // A reader resting a few px off the bottom is not snapped (isAtBottom's
    // 24px slack, shared, not a second threshold).
    expect(shouldStick(true, 1180, 2000, 800)).toBe(false)
    expect(shouldStick(true, 1175, 2000, 800)).toBe(true)
  })

  it('the overlay wires the counterweights — stream, font budget, pin-keeper', () => {
    const api = src('remote-api.ts')
    expect(between(api, 'ptyAttach:', 'listActivity:')).toContain('attachTerminalStream')

    // fonts.load() of a CDN font can stay pending forever; term.open and
    // ptyAttach must not wait past the budget.
    const overlay = src('TerminalOverlay.tsx')
    const gate = between(overlay, 'const fontReady', 'term.open(container)')
    expect(gate).toContain('Promise.race')
    expect(gate).toContain('document.fonts.load')

    const view = src('TranscriptView.tsx')
    expect(view).toContain('new ResizeObserver')
    expect(view).toContain('new MutationObserver')
    // The jump drops the pin SYNCHRONOUSLY: the pin-keeper's observers fire
    // before onScroll's rAF clears it, and a stale-true pin re-wrote
    // scrollTop to the bottom and ate the tap (measured in review).
    const jump = between(view, 'const scrollToTarget', 'scrollIntoView')
    expect(jump).toContain('pinnedRef.current = false')
  })
})
