// Sol r11 P1 — the fold's last unbounded synchronous unit leaves the thread.
//
// Round 10 bounded every ORDINARY fold stretch in bytes but stated one
// residual: a single oversized TurnRecord still JSON.parse'd and stringified
// synchronously on Electron main. The fold worker closes it: past 1 MB the
// JSON work runs in a worker thread and only memcpy-class steps (utf8
// decode, structured-clone receive, Buffer.from) remain on main.
//
// The gate is STRUCTURAL, not just timed: JSON.parse/JSON.stringify are
// spied ON THE MAIN THREAD during the fold, and no call may touch an
// oversized payload — a regression that parses the 8 MB line on main cannot
// hide behind timing noise. The heartbeat bound rides alongside: with the
// giant parse off-thread, every inter-yield stretch is ordinary-chunk sized.
//
// The worker is an optimization with a stated failure policy: crash →
// LOUD note once → synchronous fallback, correct at the old cost. Both the
// codec's own crash machinery and the fold's fallback are pinned here.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnStore } from '../src/main/turn-store'
import { TAIL_OVERLAY_COMPACT_MIN_LINES } from '../src/main/turn-store'
import {
  FoldRecordCodec,
  OVERSIZED_RECORD_BYTES,
  type CodecAnswer
} from '../src/main/turn-store-fold-worker'
import type { TurnRecord } from '../src/shared/turn'

let root: string
let dir: string
let annDir: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cookrew-fold-worker-'))
  dir = path.join(root, 'turns')
  annDir = path.join(root, 'checkpoint-annotations')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const reopen = (): TurnStore => new TurnStore(dir, annDir)
const file = (id = 't1'): string => path.join(dir, `${id}.jsonl`)

const rec = (index: number, reply: string): TurnRecord => ({
  index,
  prompt: `ask ${index}`,
  reply,
  startedAt: index * 10,
  endedAt: index * 10 + 5
})

const overlayLineFor = (record: TurnRecord): string => {
  const line = JSON.stringify(record)
  return `{"__tail":true,"supersedes":${record.index},${line.slice(1)}`
}

const BASE = 300
const GIANT_INDEX = 150
const GIANT_BYTES = 8 * 1024 * 1024

/**
 * A ledger with one 8 MB record MID-FILE (index 150 — plain, never
 * superseded, so BOTH halves of the fold must handle it: one giant line to
 * parse, one giant record to serialize) plus enough overlay weight on the
 * tail record to cross the fold policy.
 */
function writeGiantLedger(): void {
  const parts: string[] = []
  const filler = 'x'.repeat(2_000)
  const giant = 'g'.repeat(GIANT_BYTES)
  for (let i = 1; i <= BASE; i += 1) {
    parts.push(`${JSON.stringify(rec(i, i === GIANT_INDEX ? giant : filler))}\n`)
  }
  const heavy = 'y'.repeat(300_000)
  for (let i = 1; i <= TAIL_OVERLAY_COMPACT_MIN_LINES; i += 1) {
    parts.push(`${overlayLineFor(rec(BASE, `${heavy} round ${i}`))}\n`)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file(), parts.join(''), { encoding: 'utf8' })
}

/** Fold correctness after any engine: weight gone, giant intact, last-wins. */
function expectFoldedCorrectly(): void {
  expect(readFileSync(file(), 'utf8')).not.toContain('__tail')
  const replayed = reopen().load('t1')
  expect(replayed).toHaveLength(BASE)
  expect(replayed[GIANT_INDEX - 1].reply).toHaveLength(GIANT_BYTES)
  expect(replayed[BASE - 1].reply.endsWith(`round ${TAIL_OVERLAY_COMPACT_MIN_LINES}`)).toBe(true)
}

interface StoreInternals {
  foldNow(id: string): Promise<void>
  foldCodec: FoldRecordCodec
}

describe('the 8 MB record folds OFF the main thread (Sol r11 P1)', () => {
  it('no oversized JSON.parse/stringify on main, and the stretches stay ordinary-sized', async () => {
    writeGiantLedger()
    const store = reopen()
    // load() itself parses synchronously (the read path is not the fold);
    // the spies arm only around the fold.
    expect(store.load('t1')).toHaveLength(BASE)

    const parseSpy = vi.spyOn(JSON, 'parse')
    const stringifySpy = vi.spyOn(JSON, 'stringify')
    let maxGap = 0
    let last = performance.now()
    let live = true
    const tick = (): void => {
      const now = performance.now()
      maxGap = Math.max(maxGap, now - last)
      last = now
      if (live) setImmediate(tick)
    }
    setImmediate(tick)
    // The verdicts are read BEFORE mockRestore — restore resets the
    // recorded calls, and a gate read after it would pass vacuously.
    let parsedOversized = true
    let stringifiedOversized = true
    try {
      await (store as unknown as StoreInternals).foldNow('t1')
    } finally {
      live = false
      parsedOversized = parseSpy.mock.calls.some(
        ([text]) => typeof text === 'string' && text.length > OVERSIZED_RECORD_BYTES
      )
      stringifiedOversized = stringifySpy.mock.results.some(
        (result) => typeof result.value === 'string' && result.value.length > OVERSIZED_RECORD_BYTES
      )
      parseSpy.mockRestore()
      stringifySpy.mockRestore()
    }

    expectFoldedCorrectly()
    // THE STRUCTURAL GATE: the giant parse/stringify happened in the worker
    // thread, whose JSON is not this thread's spied object. Main saw only
    // ordinary payloads.
    expect(parsedOversized).toBe(false)
    expect(stringifiedOversized).toBe(false)
    // The timing corollary, generous for CI noise: without the giant parse,
    // no stretch approaches what the 8 MB JSON.parse alone used to cost.
    // (The structural spy above is the hard gate.)
    expect(maxGap).toBeLessThan(500)
  }, 240_000)

  it('worker down → LOUD note → synchronous fallback keeps the fold correct', async () => {
    writeGiantLedger()
    const store = reopen()
    expect(store.load('t1')).toHaveLength(BASE)

    // A codec whose worker is already gone: every request answers
    // worker-down, which is exactly what a crash mid-fold produces for the
    // requests behind it.
    const downCodec = {
      parseOversized: async (): Promise<CodecAnswer<unknown>> => ({ ok: 'worker-down' }),
      serializeOversized: async (): Promise<CodecAnswer<string>> => ({ ok: 'worker-down' }),
      dispose: (): void => undefined
    }
    ;(store as unknown as { foldCodec: typeof downCodec }).foldCodec = downCodec

    const parseSpy = vi.spyOn(JSON, 'parse')
    let fellBackOnMain = false
    try {
      await (store as unknown as StoreInternals).foldNow('t1')
    } finally {
      fellBackOnMain = parseSpy.mock.calls.some(
        ([text]) => typeof text === 'string' && text.length > OVERSIZED_RECORD_BYTES
      )
      parseSpy.mockRestore()
    }
    expectFoldedCorrectly()
    // The fallback genuinely ran on main — the giant line WAS parsed here.
    expect(fellBackOnMain).toBe(true)
  }, 240_000)
})

describe('FoldRecordCodec — the crash machinery itself', () => {
  it('round-trips parse and serialize through the real worker', async () => {
    const codec = new FoldRecordCodec()
    try {
      const parsed = await codec.parseOversized('{"a":1,"b":"two"}')
      expect(parsed).toEqual({ ok: true, value: { a: 1, b: 'two' } })
      const serialized = await codec.serializeOversized({ a: 1 })
      expect(serialized).toEqual({ ok: true, value: '{"a":1}' })
    } finally {
      codec.dispose()
    }
  })

  it("answers 'invalid' for a line that does not parse — the drop verdict, not a crash", async () => {
    const codec = new FoldRecordCodec()
    try {
      await expect(codec.parseOversized('{"torn')).resolves.toEqual({ ok: 'invalid' })
      // The worker survived the bad input: the next request still works.
      await expect(codec.parseOversized('{"ok":true}')).resolves.toEqual({
        ok: true,
        value: { ok: true }
      })
    } finally {
      codec.dispose()
    }
  })

  it('a spawn that refuses latches broken with ONE loud note; requests answer worker-down', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const codec = new FoldRecordCodec(() => {
        throw new Error('no worker for you')
      })
      await expect(codec.parseOversized('{"a":1}')).resolves.toEqual({ ok: 'worker-down' })
      await expect(codec.serializeOversized({ a: 1 })).resolves.toEqual({ ok: 'worker-down' })
      const notes = quiet.mock.calls.filter((args) =>
        String(args[0]).includes('fold worker died')
      )
      expect(notes).toHaveLength(1) // loud ONCE, silent degradation after
    } finally {
      quiet.mockRestore()
    }
  })

  it('a crash with requests in flight settles them worker-down and stays broken', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // A real worker that dies instead of answering.
      const { Worker } = await import('node:worker_threads')
      const codec = new FoldRecordCodec(
        () => new Worker('process.exit(1)', { eval: true })
      )
      await expect(codec.parseOversized('{"a":1}')).resolves.toEqual({ ok: 'worker-down' })
      // Latched: no respawn flapping — deterministic fallback from here on.
      await expect(codec.parseOversized('{"a":1}')).resolves.toEqual({ ok: 'worker-down' })
      expect(
        quiet.mock.calls.filter((args) => String(args[0]).includes('fold worker died'))
      ).toHaveLength(1)
    } finally {
      quiet.mockRestore()
    }
  })
})
