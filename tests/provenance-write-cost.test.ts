// The write-ahead mark stops rewriting the world on every keystroke.
//
// markDirty is called BEFORE every byte crosses into a pane, and a mark that
// cannot commit REFUSES the byte. So its cost is the floor under typing.
//
// It used to rewrite the ENTIRE records map through writeFileAtomic — temp
// write, file fsync, rename, parent-dir fsync — so every keystroke paid two
// fsyncs over a payload of size O(every terminal ever marked). That map is
// uptime-monotonic, which is why the owner reported lag that "gets worse the
// longer the app runs" and does not recover on reload.
//
// The debounce that was supposed to prevent this is defeated in exactly the
// typing loop: a locally observed submit sets consumedLocally, so the NEXT
// keystroke re-stamps and writes. The field header already stated the intent —
// "marks must not write per keystroke" — so this pins the cost, not just the
// behaviour, in the session-drain-cost pattern.

import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { InputProvenanceStore } from '../src/main/input-provenance'

/** Directories handed to fsyncDirDurable, so the HIGH has a real witness. */
const dirFsyncs: string[] = []
vi.mock('../src/main/turn-annotations', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    fsyncDirDurable: (parent: string) => {
      dirFsyncs.push(parent)
      ;(actual.fsyncDirDurable as (p: string) => void)(parent)
    }
  }
})

const fresh = (): { store: InputProvenanceStore; file: string } => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'prov-')), 'input-provenance.json')
  return { store: new InputProvenanceStore(file), file }
}

/** Bytes on disk for the snapshot plus its journal — the real write volume. */
const onDisk = (file: string): number => {
  const size = (f: string): number => (existsSync(f) ? statSync(f).size : 0)
  return size(file) + size(`${file}.log`)
}

describe('a keystroke does not rewrite every other terminal', () => {
  it('cost per mark does not grow with the number of terminals marked', () => {
    // The defect in one assertion. With a full-snapshot write, the bytes
    // written per keystroke scale with the map; with a journal they do not.
    const { store, file } = fresh()
    for (let i = 0; i < 200; i += 1) store.markDirty(`bystander-${i}`, 'x')

    const before = onDisk(file)
    store.markDirty('the-terminal-being-typed-into', 'x')
    const afterOne = onDisk(file)

    // One mark must cost about one record, not 200.
    const perMark = afterOne - before
    expect(perMark).toBeLessThan(400)
  })

  it('the same mark costs the same with 10 terminals as with 500', () => {
    const small = fresh()
    for (let i = 0; i < 10; i += 1) small.store.markDirty(`t-${i}`, 'x')
    const smallBefore = onDisk(small.file)
    small.store.markDirty('probe', 'x')
    const smallCost = onDisk(small.file) - smallBefore

    const big = fresh()
    for (let i = 0; i < 500; i += 1) big.store.markDirty(`t-${i}`, 'x')
    const bigBefore = onDisk(big.file)
    big.store.markDirty('probe', 'x')
    const bigCost = onDisk(big.file) - bigBefore

    // Flat, not proportional. A 50x map must not mean a 50x keystroke.
    expect(bigCost).toBeLessThan(smallCost * 3)
  })
})

describe('durability is unchanged — the whole point of the store', () => {
  it('a mark survives process replacement', () => {
    const { store, file } = fresh()
    expect(store.markDirty('t1', 'x')).toBe(true)

    const reopened = new InputProvenanceStore(file)
    expect(reopened.takeAdoptable('t1')).toBe('owner-dirty')
  })

  it('marks survive when only the journal exists (before any compaction)', () => {
    // The first 200 marks live entirely in the journal. If replay were missing
    // they would be silently unprotected — a false-clean box, the exact crash
    // window this store exists to close.
    const { store, file } = fresh()
    store.markDirty('t1', 'x')
    store.markDirty('t2', 'x')

    const reopened = new InputProvenanceStore(file)
    expect(reopened.takeAdoptable('t1')).toBe('owner-dirty')
    expect(reopened.takeAdoptable('t2')).toBe('owner-dirty')
  })

  it('a clear is not resurrected by a stale journal line', () => {
    // The failure the suite caught while this was being written: a full
    // snapshot that did not truncate the journal let older lines replay over
    // it. A cleared fact coming back would block a live producer forever.
    const { store, file } = fresh()
    store.markDirty('t1', 'x')
    store.clear('t1')

    const reopened = new InputProvenanceStore(file)
    expect(reopened.takeAdoptable('t1')).toBeNull()
  })

  it('survives a torn last line without losing what came before', () => {
    // A crash mid-append. Dropping the tail can only LOSE a mark, never invent
    // one, and an absent mark is the "unproven" case the adoption rules
    // already handle fail-closed.
    const { store, file } = fresh()
    store.markDirty('t1', 'x')
    const journal = `${file}.log`
    const { appendFileSync } = require('node:fs') as typeof import('node:fs')
    appendFileSync(journal, '{"id":"t2","kind":"owner-di')

    const reopened = new InputProvenanceStore(file)
    expect(reopened.takeAdoptable('t1')).toBe('owner-dirty')
    expect(reopened.takeAdoptable('t2')).toBeNull()
  })
})

describe('the map is bounded — reap drops what protects nothing', () => {
  it('drops records for terminals no workspace claims', () => {
    const { store } = fresh()
    store.markDirty('alive', 'x')
    store.markDirty('gone-1', 'x')
    store.markDirty('gone-2', 'x')

    expect(store.reap(() => ['alive'])).toBe(2)
  })

  it('REFUSES to reap when the enumeration THROWS', () => {
    // allTerminalIdsStrict throws rather than under-reporting a workspace it
    // could not read. An under-report would delete facts protecting live
    // panes — the one direction this store must never fail in. The
    // enumeration vouches by succeeding; a throw skips the reap entirely.
    const { store } = fresh()
    store.markDirty('alive', 'x')
    store.markDirty('maybe-alive', 'x')

    expect(
      store.reap(() => {
        throw new Error('a workspace file would not load')
      })
    ).toBe(0)
  })

  it('a reaped record does not come back after a reopen', () => {
    const { store, file } = fresh()
    store.markDirty('alive', 'x')
    store.markDirty('gone', 'x')
    store.reap(() => ['alive'])

    const reopened = new InputProvenanceStore(file)
    expect(reopened.takeAdoptable('alive')).toBe('owner-dirty')
    expect(reopened.takeAdoptable('gone')).toBeNull()
  })

  it('keeps a live terminal even when it was marked long ago', () => {
    const { store } = fresh()
    store.markDirty('old-but-live', 'x')
    expect(store.reap(() => ['old-but-live'])).toBe(0)
  })
})

describe('replay stays bounded', () => {
  it('compacts rather than growing the journal without limit', () => {
    const { store, file } = fresh()
    for (let i = 0; i < 600; i += 1) store.markDirty(`t-${i % 7}`, 'x')

    const journal = `${file}.log`
    const journalLines = existsSync(journal)
      ? readFileSync(journal, 'utf8').split('\n').filter(Boolean).length
      : 0
    // 600 marks must not mean 600 lines to replay at next boot.
    expect(journalLines).toBeLessThan(600)
  })
})

describe("the journal's own existence is durable (Tinker HIGH)", () => {
  it('fsyncs the parent directory when CREATING the journal', () => {
    // Fsyncing the file does not make its DIRECTORY ENTRY durable. Without the
    // parent fsync, markDirty returns true, the byte crosses, power is lost,
    // and the journal is simply absent at next boot — so the box adopts CLEAN
    // on an "absence is evidence" rule that had stopped being evidence.
    // Fail-closed depends on the file existing, so its existence must be
    // durable too.
    dirFsyncs.length = 0
    const { store, file } = fresh()
    store.markDirty('t1', 'x')

    expect(dirFsyncs).toContain(path.dirname(`${file}.log`))
  })

  it('does not pay the directory fsync on every subsequent mark', () => {
    // It is only the CREATION that makes a new directory entry. Paying it per
    // keystroke would put back a second fsync — half the cost just removed.
    const { store, file } = fresh()
    store.markDirty('t1', 'x')
    const journal = `${file}.log`
    expect(existsSync(journal)).toBe(true)

    // Subsequent marks append to a file that already has its entry.
    for (let i = 0; i < 5; i += 1) expect(store.markDirty(`t-${i}`, 'x')).toBe(true)
  })
})

describe('a failing compaction backs off (Tinker MED-1)', () => {
  it('does not attempt a full write on every keystroke when compaction fails', () => {
    // Disk-full is exactly when you must not reinstate a per-keystroke
    // full-map write. Backoff moves the THRESHOLD; resetting the count would
    // drop the replay bound instead, which is the other thing that must not
    // happen.
    const fsMod = require('node:fs') as typeof import('node:fs')
    const { store } = fresh()
    for (let i = 0; i < 205; i += 1) store.markDirty(`t-${i % 5}`, 'x')

    let fullWrites = 0
    const spy = vi.spyOn(fsMod, 'writeFileSync').mockImplementation((() => {
      fullWrites += 1
      throw new Error('ENOSPC')
    }) as never)
    for (let i = 0; i < 60; i += 1) store.markDirty(`t-${i % 5}`, 'x')
    spy.mockRestore()

    // 60 keystrokes must not mean 60 attempted full writes.
    expect(fullWrites).toBeLessThan(10)
  })
})

describe('replay accepts only what the writer emits (Tinker MED-2)', () => {
  it('refuses to rebuild a dispatch-delivery from a journal line', () => {
    // A dispatch-delivery carries a PROMPT that only the snapshot path
    // persists. Rebuilding one from a journal line would produce a record
    // without it, and promptAnswersDispatch would compare against undefined
    // and silently stop matching. The writer never emits this shape, so the
    // reader must not accept it.
    const { store, file } = fresh()
    store.markDirty('t1', 'x')
    const fsMod = require('node:fs') as typeof import('node:fs')
    fsMod.appendFileSync(
      `${file}.log`,
      `${JSON.stringify({ id: 'forged', kind: 'dispatch-delivery', markedAt: Date.now() })}\n`
    )

    const reopened = new InputProvenanceStore(file)
    expect(reopened.takeAdoptable('forged')).toBeNull()
    expect(reopened.takeAdoptable('t1')).toBe('owner-dirty')
  })
})
