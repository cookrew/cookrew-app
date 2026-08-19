// Sol r10 P1 — a fold-created directory-fsync debt has its own retry trigger.
//
// The fold commits with rename + parent-dir fsync. When that fsync fails, the
// rename has LANDED — the file holds the folded records — but the directory
// entry's durability is unproven, and the r9 shape recorded the debt and
// reported the fold complete without scheduling anything: only flush()
// settled debt, and a ledger that just compacted is exactly the ledger that
// may never flush again. A crash could still lose the renamed entry, and a
// persistent fault never reached the repeat-failure escalation.
//
// Now the failure arms a DEBT-ONLY retry — unref'd timer, doubling backoff —
// independent of new turns; repeated failure escalates PERSISTENT STORAGE
// FAULT out loud; and flushAll (app quit) settles or escalates whatever is
// still outstanding.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnStore } from '../src/main/turn-store'
import { TAIL_OVERLAY_COMPACT_MIN_LINES } from '../src/main/turn-store'
import type { TurnRecord } from '../src/shared/turn'

/** Fault injection for the ASYNC dir fsync: fail handle.sync() for opens of
 *  this exact path (the turns directory) while set. */
const fault = vi.hoisted(() => ({ failDir: null as string | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  type Handle = Awaited<ReturnType<typeof actual.open>>
  const failing = (handle: Handle): Handle =>
    new Proxy(handle, {
      get(target, prop) {
        if (prop === 'sync') {
          return async (): Promise<void> => {
            throw Object.assign(new Error('EIO: injected dir-fsync failure'), { code: 'EIO' })
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
      return fault.failDir !== null && String(args[0]) === fault.failDir
        ? failing(handle)
        : handle
    }) as typeof actual.open
  }
})

let root: string
let dir: string
let annDir: string
let quiet: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  fault.failDir = null
  root = mkdtempSync(path.join(tmpdir(), 'cookrew-fold-debt-'))
  dir = path.join(root, 'turns')
  annDir = path.join(root, 'checkpoint-annotations')
  quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  fault.failDir = null
  // Disarm before the directory goes: a test that ends mid-escalation leaves an
  // armed retry behind, and an unref'd timer still fires. It then fsyncs a path
  // rmSync has just deleted and prints PERSISTENT STORAGE FAULT into whatever
  // test is running by then — `quiet` is already restored, so it lands on the
  // real console and reads like a failure somewhere else entirely.
  for (const store of stores.splice(0)) {
    const internals = store as unknown as Internals
    for (const timer of internals.debtTimers.values()) clearTimeout(timer)
    internals.debtTimers.clear()
    internals.dirDebt.clear()
  }
  // Restore the spy AFTER the directory is gone, and only once the loop has
  // turned. Disarming above cannot catch a retry already in flight — its fsync
  // is mid-await on the threadpool — and that attempt lands after rmSync, on a
  // path that no longer exists. Restoring first would put its PERSISTENT
  // STORAGE FAULT on the real console, attributed to whatever test is running
  // by then. One macrotask is enough for the in-flight rejection to unwind.
  rmSync(root, { recursive: true, force: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  quiet.mockRestore()
})

/** Every store built by a test, so afterEach can disarm their retries. */
const stores: TurnStore[] = []

const reopen = (): TurnStore => {
  const store = new TurnStore(dir, annDir)
  stores.push(store)
  return store
}
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
  dirDebt: Set<string>
  debtTimers: Map<string, NodeJS.Timeout>
}

/** Load, then drive the fold directly with the dir fsync failing. */
async function foldIntoDebt(store: TurnStore): Promise<Internals> {
  const loaded = store.load('t1')
  expect(loaded).toHaveLength(BASE)
  fault.failDir = dir
  const internals = store as unknown as Internals
  await internals.foldNow('t1')
  // The rename LANDED — the folded file is real — but the entry is unproven.
  expect(readFileSync(file(), 'utf8')).not.toContain('__tail')
  expect(internals.dirDebt.has('t1')).toBe(true)
  return internals
}

/**
 * Poll until `done` holds. `what` names the condition: a timeout here reports
 * which wait expired, not just that one did — "condition never held" made three
 * different failures indistinguishable in CI output.
 */
const until = async (deadlineMs: number, what: string, done: () => boolean): Promise<void> => {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`never held within ${deadlineMs}ms: ${what}`)
}

describe('fold rename → dir-fsync failure → debt-only retry (Sol r10)', () => {
  it('settles the debt from the timer alone — NO new records, NO flush', async () => {
    writeFoldableLedger()
    const store = reopen()
    const internals = await foldIntoDebt(store)
    expect(internals.debtTimers.size).toBe(1)

    // The storage recovers; nothing else touches the store. The unref'd
    // backoff timer (base 500ms) must land the fsync by itself.
    fault.failDir = null
    await until(5_000, 'the debt-only retry settles the fsync', () => !internals.dirDebt.has('t1'))
    expect(internals.debtTimers.size).toBe(0)
  })

  it('escalates a REPEATED failure as a PERSISTENT STORAGE FAULT, and keeps retrying', async () => {
    writeFoldableLedger()
    const store = reopen()
    const internals = await foldIntoDebt(store)

    // The fault stands: the first retry is already a repeat on this
    // directory, and the shared escalation must say so out loud.
    await until(5_000, 'a repeat failure escalates to PERSISTENT STORAGE FAULT', () =>
      quiet.mock.calls.some((args) => String(args[0]).includes('PERSISTENT STORAGE FAULT'))
    )
    expect(internals.dirDebt.has('t1')).toBe(true)
    // Still armed: the debt keeps retrying until the fsync lands or quit.
    //
    // Waited for, not asserted on the spot. The escalation is logged INSIDE
    // fsyncDirAsync just before it throws, while the re-arm happens after that
    // rejection unwinds through retryDirDebt's catch — with an `await
    // handle.close()` in between. So there is a real window where the fired
    // timer has been dropped and its replacement not yet set, and the poll
    // above can land in it. Asserting `size === 1` at that instant read as
    // "the retry was never re-armed"; the debt was never at risk. Under load
    // the window widens, which is why this only ever failed in a full run.
    await until(5_000, 'the retry re-arms after the escalated failure', () => internals.debtTimers.size === 1)
  })

  it('flushAll settles outstanding debt at quit — the last chance to prove the rename', async () => {
    writeFoldableLedger()
    const store = reopen()
    const internals = await foldIntoDebt(store)

    // Quit-time settlement rides the SYNC fsync (unmocked here): the debt
    // and its retry state are gone without any new turn ever arriving.
    store.flushAll()
    expect(internals.dirDebt.has('t1')).toBe(false)
    expect(internals.debtTimers.size).toBe(0)
  })
})
