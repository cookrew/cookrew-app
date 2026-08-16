// Sol r10 P1 — the fold is BYTE-bounded and its durability is off-main.
//
// The r9 fold yielded per 256 KiB read and per 200 RECORDS serialized, which
// bounded nothing in bytes: one oversized JSONL record Buffer.concat'ed an
// O(n²) carry on the read side, 200 large records serialized as one stretch
// on the write side, and the final fsyncSync blocked Electron main for as
// long as slow storage took. The fold now:
//
//   - accumulates the carry as CHUNKS, concatenated once per line region;
//   - serializes by accumulated BYTES (~256 KiB), never record count;
//   - isolates an OVERSIZED record in its own unit, yielding before and
//     after — the JSON.parse/stringify of one 8 MB line is the stated
//     irreducible residual (a worker is the only way off this thread);
//   - writes and fsyncs the temp through an fs/promises FileHandle (libuv
//     threadpool), proven here by a DELAYED async fsync that does NOT show
//     up as an event-loop stall, and by a spy proving fsyncSync is never
//     called on the fold path.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnStore } from '../src/main/turn-store'
import { TAIL_OVERLAY_COMPACT_MIN_LINES } from '../src/main/turn-store'
import type { TurnRecord } from '../src/shared/turn'

/** How long the mocked temp-file fsync dawdles. A SYNCHRONOUS fsync of this
 *  length would stall the heartbeat by exactly this much; the async handle
 *  must not. The inter-yield bound below is deliberately the same number. */
const FSYNC_DELAY_MS = 800

const meter = vi.hoisted(() => ({
  active: false,
  fsyncSyncs: 0,
  handleSyncs: 0,
  delayTempFsync: false
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    fsyncSync: ((...args: Parameters<typeof actual.fsyncSync>) => {
      if (meter.active) meter.fsyncSyncs += 1
      return actual.fsyncSync(...args)
    }) as typeof actual.fsyncSync
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  type Handle = Awaited<ReturnType<typeof actual.open>>
  const wrap = (handle: Handle): Handle =>
    new Proxy(handle, {
      get(target, prop) {
        if (prop === 'sync') {
          return async () => {
            if (meter.active) meter.handleSyncs += 1
            if (meter.delayTempFsync) {
              await new Promise((resolve) => setTimeout(resolve, FSYNC_DELAY_MS))
            }
            return target.sync()
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as Handle
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      return String(args[0]).endsWith('.fold.tmp') ? wrap(handle) : handle
    }) as typeof actual.open
  }
})

let root: string
let dir: string
let annDir: string

beforeEach(() => {
  meter.active = false
  meter.fsyncSyncs = 0
  meter.handleSyncs = 0
  meter.delayTempFsync = false
  root = mkdtempSync(path.join(tmpdir(), 'cookrew-fold-bytes-'))
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

describe('one 8 MB record + delayed fsync — bounded stretches, async durability (Sol r10)', () => {
  /** One measured direct fold; correctness asserted unconditionally. */
  async function measureFold(): Promise<number> {
    writeGiantLedger()
    const store = reopen()
    const loaded = store.load('t1') // seeds the tail; schedules a fold
    expect(loaded).toHaveLength(BASE)
    expect(loaded[GIANT_INDEX - 1].reply).toHaveLength(GIANT_BYTES)

    meter.active = true
    meter.delayTempFsync = true
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
    try {
      // Driven directly (same tick as load, so the load-scheduled fold
      // stands down to this one's single-flight) and awaited to completion.
      const internals = store as unknown as { foldNow(id: string): Promise<void> }
      await internals.foldNow('t1')
    } finally {
      live = false
      meter.active = false
      meter.delayTempFsync = false
    }

    // Folded CORRECTLY: overlay weight gone, the giant record intact,
    // last-wins preserved on the superseded tail.
    const folded = readFileSync(file(), 'utf8')
    expect(folded).not.toContain('__tail')
    const replayed = reopen().load('t1')
    expect(replayed).toHaveLength(BASE)
    expect(replayed[GIANT_INDEX - 1].reply).toHaveLength(GIANT_BYTES)
    expect(
      replayed[BASE - 1].reply.endsWith(`round ${TAIL_OVERLAY_COMPACT_MIN_LINES}`)
    ).toBe(true)

    // Durability went through the ASYNC handle, never fsyncSync: the spy is
    // the structural half of the gate — a regression to the synchronous
    // fsync cannot fake this whatever the timing noise does.
    expect(meter.fsyncSyncs).toBe(0)
    expect(meter.handleSyncs).toBeGreaterThanOrEqual(1)
    return maxGap
  }

  it('never stalls the loop for the delayed fsync, and bounds every stretch', async () => {
    // The bound EQUALS the injected fsync delay: a fold that still fsync'ed
    // synchronously would stall the heartbeat ≥ FSYNC_DELAY_MS on every
    // attempt, while the genuine residual — JSON.parse/stringify of the one
    // 8 MB line, irreducible without a worker — measures far below it.
    // Best-of-three per repo precedent: the in-suite heartbeat cannot tell
    // the fold blocking the loop from the OS starving this worker.
    let best = Number.POSITIVE_INFINITY
    for (let attempt = 0; attempt < 3 && best >= FSYNC_DELAY_MS; attempt += 1) {
      best = Math.min(best, await measureFold())
      if (attempt < 2 && best >= FSYNC_DELAY_MS) {
        rmSync(root, { recursive: true, force: true })
        mkdirSync(root, { recursive: true })
      }
    }
    expect(best).toBeLessThan(FSYNC_DELAY_MS)
  }, 240_000)
})
