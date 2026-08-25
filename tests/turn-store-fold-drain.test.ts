// Sol r11 P1 — flushAll's debt sweep is point-in-time; drainFolds closes the
// fold that renames AFTER it looked.
//
// The exact interleaving Sol named: a fold is paused before its rename when
// flushAll runs its sweep — no debt exists yet, so the sweep sees a clean
// store — then the fold renames, its async directory fsync fails, and the
// debt is minted AFTER the last synchronous look. The retry timer is unref'd
// and nothing else flushes before quit: a crash could lose the renamed
// directory entry. drainFolds is the bounded async drain the conductor
// awaits in before-quit: latch (no new folds), await in-flight folds up to
// the cap, revoke the overrunners (generation bump — their commit refuses
// the rename), then settle every debt created through their completion.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnStore } from '../src/main/turn-store'
import { TAIL_OVERLAY_COMPACT_MIN_LINES } from '../src/main/turn-store'
import type { TurnRecord } from '../src/shared/turn'

/**
 * Fault/pause injection for the ASYNC fs seams: the fold's temp fsync can be
 * PAUSED on a gate (the fold is then provably "before its rename"), and the
 * turns directory's async fsync can be made to fail (the debt-minting leg).
 */
const seams = vi.hoisted(() => ({
  failDir: null as string | null,
  pauseTempSync: false,
  tempSyncWaiting: [] as Array<() => void>
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  type Handle = Awaited<ReturnType<typeof actual.open>>
  const wrap = (handle: Handle, target: string): Handle =>
    new Proxy(handle, {
      get(getTarget, prop) {
        if (prop === 'sync') {
          return async (): Promise<void> => {
            if (target === 'dir') {
              throw Object.assign(new Error('EIO: injected dir-fsync failure'), { code: 'EIO' })
            }
            if (seams.pauseTempSync) {
              await new Promise<void>((resolve) => seams.tempSyncWaiting.push(resolve))
            }
            return getTarget.sync()
          }
        }
        const value = Reflect.get(getTarget, prop)
        return typeof value === 'function' ? value.bind(getTarget) : value
      }
    }) as Handle
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args)
      const name = String(args[0])
      if (name.endsWith('.fold.tmp')) return wrap(handle, 'temp')
      if (seams.failDir !== null && name === seams.failDir) return wrap(handle, 'dir')
      return handle
    }) as typeof actual.open
  }
})

let root: string
let dir: string
let annDir: string
let quiet: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  seams.failDir = null
  seams.pauseTempSync = false
  seams.tempSyncWaiting = []
  root = mkdtempSync(path.join(tmpdir(), 'cookrew-fold-drain-'))
  dir = path.join(root, 'turns')
  annDir = path.join(root, 'checkpoint-annotations')
  quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  seams.failDir = null
  seams.pauseTempSync = false
  for (const release of seams.tempSyncWaiting) release()
  seams.tempSyncWaiting = []
  quiet.mockRestore()
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

const BASE = 100

/** A small overlay-heavy ledger, past the fold policy on load. */
function writeFoldableLedger(): void {
  const parts: string[] = []
  for (let i = 1; i <= BASE; i += 1) parts.push(`${JSON.stringify(rec(i, 'x'.repeat(1_000)))}\n`)
  const heavy = 'y'.repeat(2_000)
  for (let i = 1; i <= TAIL_OVERLAY_COMPACT_MIN_LINES; i += 1) {
    parts.push(`${overlayLineFor(rec(BASE, `${heavy} round ${i}`))}\n`)
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(file(), parts.join(''), { encoding: 'utf8' })
}

interface Internals {
  foldNow(id: string): Promise<void>
  scheduleFold(id: string): void
  dirDebt: Set<string>
  debtTimers: Map<string, NodeJS.Timeout>
  pendingCompact: Map<string, NodeJS.Timeout>
  foldRuns: Map<string, Promise<void>>
}

const internalsOf = (store: TurnStore): Internals => store as unknown as Internals

const until = async (deadlineMs: number, done: () => boolean): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition never held')
}

// Windows: directory fsync is a POSIX durability primitive not available on NTFS — macOS/Linux CI covers it.
describe.skipIf(process.platform === 'win32')('drainFolds — the interleaving flushAll cannot see (Sol r11 P1)', () => {
  it('fold paused before rename → flushAll sweeps clean → rename + dir-fsync failure → the DRAIN settles it', async () => {
    writeFoldableLedger()
    const store = reopen()
    const internals = internalsOf(store)
    expect(store.load('t1')).toHaveLength(BASE)

    // Pause the fold at its temp fsync — provably BEFORE the rename.
    seams.pauseTempSync = true
    const run = internals.foldNow('t1')
    await until(5_000, () => seams.tempSyncWaiting.length === 1)
    expect(readFileSync(file(), 'utf8')).toContain('__tail') // not renamed yet

    // flushAll's point-in-time sweep: no debt exists, nothing to settle —
    // the exact blindness Sol named.
    store.flushAll()
    expect(internals.dirDebt.size).toBe(0)

    // The fold proceeds: rename lands, the async directory fsync fails —
    // a durability obligation minted AFTER the last synchronous look.
    seams.failDir = dir
    seams.pauseTempSync = false
    seams.tempSyncWaiting.shift()!()
    await run
    expect(readFileSync(file(), 'utf8')).not.toContain('__tail') // renamed
    expect(internals.dirDebt.has('t1')).toBe(true) // the debt flushAll missed

    // The drain settles it through the SYNC fsync (the injected fault only
    // covers the async seam — storage itself is healthy), within its bound.
    await store.drainFolds(2_000)
    expect(internals.dirDebt.size).toBe(0)
    expect(internals.debtTimers.size).toBe(0)
    expect(internals.foldRuns.size).toBe(0)
  })

  it('once draining, no NEW fold can be scheduled or started', async () => {
    writeFoldableLedger()
    const store = reopen()
    const internals = internalsOf(store)
    expect(store.load('t1')).toHaveLength(BASE)
    // Drain first (the load-scheduled fold is cancelled by the latch step),
    // then try to fold again: both doors must refuse.
    await store.drainFolds(2_000)
    internals.scheduleFold('t1')
    expect(internals.pendingCompact.size).toBe(0)
    await internals.foldNow('t1')
    expect(internals.foldRuns.size).toBe(0)
    expect(readFileSync(file(), 'utf8')).toContain('__tail') // untouched
  })

  it('a fold still running past the cap is REVOKED: no late rename, no unseen debt', async () => {
    writeFoldableLedger()
    const store = reopen()
    const internals = internalsOf(store)
    expect(store.load('t1')).toHaveLength(BASE)

    seams.pauseTempSync = true
    const run = internals.foldNow('t1')
    await until(5_000, () => seams.tempSyncWaiting.length === 1)

    // The drain caps out while the fold hangs; the overrunner's generation
    // is bumped, so its eventual commit refuses the rename.
    const before = Date.now()
    await store.drainFolds(100)
    expect(Date.now() - before).toBeLessThan(1_500)

    seams.failDir = dir // would mint debt IF the rename landed — it must not
    seams.pauseTempSync = false
    seams.tempSyncWaiting.shift()!()
    await run
    // The commit was revoked: overlays intact (the next boot's load-time
    // fold reclaims them), and no debt appeared behind the drain's sweep.
    expect(readFileSync(file(), 'utf8')).toContain('__tail')
    expect(internals.dirDebt.size).toBe(0)
    expect(internals.debtTimers.size).toBe(0)
  })
})
