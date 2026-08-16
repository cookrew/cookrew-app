// Sol r10 P0-1 — the input-provenance WAL. Panes outlive the process, so the
// dirty/contaminated facts protecting their input boxes must too: recorded
// durably BEFORE any byte or paste crosses the pane boundary, cleared durably
// only by an observed submit, the proven single-line clear, or terminal
// retirement — and adopted fail-closed by the next process at first sight of
// the terminal id. Absence of a record adopts CLEAN, because every dirtying
// write was WAL-first.

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InputProvenanceStore, dirtiesInputBox } from '../src/main/input-provenance'
import { ProducerLease } from '../src/main/producer-lease'
import { TurnTracker } from '../src/main/turn-tracker'
import { pasteAndSubmit } from '../src/main/ask'
import type { PtySession } from '../src/main/pty'

const walFile = (): string =>
  path.join(mkdtempSync(path.join(tmpdir(), 'cookrew-wal-')), 'input-provenance.json')

class FakeSession extends EventEmitter {
  terminalId = 'term-1'
  fullText(): string {
    return ''
  }
  viewportText(): string {
    return ''
  }
  idleFor(): number {
    return 99_999
  }
}

/** One "process": a store on the shared file, plus lease/tracker/session. */
function processWorld(file: string): {
  store: InputProvenanceStore
  lease: ProducerLease
  tracker: TurnTracker
  session: FakeSession
} {
  const store = new InputProvenanceStore(file)
  const lease = new ProducerLease(store)
  const tracker = new TurnTracker(async () => null, null, lease)
  const session = new FakeSession()
  tracker.track(session as unknown as PtySession, true)
  return { store, lease, tracker, session }
}

/** Mirror of PtySession.write: the WAL-first mark, then the delivered byte. */
function type(
  world: { lease: ProducerLease; session: FakeSession },
  data: string,
  source?: 'dispatch'
): void {
  world.lease.noteBytesEntering(world.session.terminalId, data)
  world.session.emit('input', data, source)
}

describe('InputProvenanceStore — durable write-ahead semantics', () => {
  it('markDirty is synchronous-durable: a NEW store on the same file sees it', () => {
    const file = walFile()
    const store = new InputProvenanceStore(file)
    store.markDirty('term-1')
    // The WAL guarantee: by the time markDirty returns, the fact is on disk.
    expect(new InputProvenanceStore(file).recordOf('term-1')).toBe('dirty')
  })

  it('contaminated upgrades dirty and is never downgraded by later dirty marks', () => {
    const file = walFile()
    const store = new InputProvenanceStore(file)
    store.markDirty('term-1')
    store.markContaminated('term-1')
    store.markDirty('term-1')
    expect(store.recordOf('term-1')).toBe('contaminated')
    expect(new InputProvenanceStore(file).recordOf('term-1')).toBe('contaminated')
  })

  it('debounces: repeated marks for the same id cost one write, no-op clears cost none', () => {
    const store = new InputProvenanceStore(walFile())
    store.markDirty('term-1')
    store.markDirty('term-1', 'more typing')
    store.markDirty('term-1')
    expect(store.persistCount()).toBe(1)
    store.clear('term-2') // nothing recorded — nothing written
    expect(store.persistCount()).toBe(1)
    store.clear('term-1')
    expect(store.persistCount()).toBe(2)
  })

  it('clear removes the record durably', () => {
    const file = walFile()
    const store = new InputProvenanceStore(file)
    store.markDirty('term-1')
    store.clear('term-1')
    expect(store.recordOf('term-1')).toBeNull()
    expect(new InputProvenanceStore(file).recordOf('term-1')).toBeNull()
  })

  it('takeAdoptable hands each loaded fact out exactly once', () => {
    const file = walFile()
    new InputProvenanceStore(file).markDirty('term-1')
    const next = new InputProvenanceStore(file)
    expect(next.takeAdoptable('term-1')).toBe('dirty')
    expect(next.takeAdoptable('term-1')).toBeNull()
    // The record itself stands until a real clear.
    expect(next.recordOf('term-1')).toBe('dirty')
  })

  it('facts marked in THIS process are not adoptable — adoption is for dying words only', () => {
    const store = new InputProvenanceStore(walFile())
    store.markDirty('term-1')
    expect(store.takeAdoptable('term-1')).toBeNull()
  })

  it('a corrupt file loses the facts out loud and every box adopts clean', () => {
    const file = walFile()
    writeFileSync(file, '{not json')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const store = new InputProvenanceStore(file)
      expect(store.recordOf('term-1')).toBeNull()
      expect(store.takeAdoptable('term-1')).toBeNull()
      expect(errors).toHaveBeenCalled()
      // The store still works from here.
      store.markDirty('term-1')
      expect(new InputProvenanceStore(file).recordOf('term-1')).toBe('dirty')
    } finally {
      errors.mockRestore()
    }
  })

  it('persists as an atomic single JSON file (tmp+rename shape)', () => {
    const file = walFile()
    const store = new InputProvenanceStore(file)
    store.markDirty('term-1')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      boxes: Record<string, { fact: string }>
    }
    expect(parsed.version).toBe(1)
    expect(parsed.boxes['term-1'].fact).toBe('dirty')
  })
})

describe('dirtiesInputBox — only content-bearing chunks mark', () => {
  it('typed text, pastes and split markers dirty the box', () => {
    expect(dirtiesInputBox('a')).toBe(true)
    expect(dirtiesInputBox('   ')).toBe(true) // whitespace is real bytes
    expect(dirtiesInputBox('\x1b[200~pasted\x1b[201~')).toBe(true)
    expect(dirtiesInputBox('\x1b[200~still open')).toBe(true)
    expect(dirtiesInputBox('\x1b[20')).toBe(true) // withheld partial marker
    expect(dirtiesInputBox('abc\rdef')).toBe(true) // bytes past the submit
  })

  it('navigation, interrupts and fully-consumed submits do not', () => {
    expect(dirtiesInputBox('\x1b[<64;10;10M')).toBe(false) // SGR wheel
    expect(dirtiesInputBox('\x1b[A')).toBe(false) // arrow
    expect(dirtiesInputBox('\x1b')).toBe(false) // bare ESC = interrupt key
    expect(dirtiesInputBox('\r')).toBe(false) // bare Enter consumes
    expect(dirtiesInputBox('abc\r')).toBe(false) // the chunk submits itself
    expect(dirtiesInputBox('\x15')).toBe(false) // kill-line adds nothing
  })
})

// ---------------------------------------------------------------------------
// The restart matrix: same WAL file, fresh store + lease + tracker — the
// simulated process replacement the r10 P0 names.
// ---------------------------------------------------------------------------

describe('input provenance across process replacement (Sol r10 P0-1)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('type → restart: ownerComposing stands, so dispatch admission refuses', () => {
    const file = walFile()
    const before = processWorld(file)
    type(before, 'half a prompt for the release')
    expect(before.tracker.ownerComposing('term-1')).toBe(true)
    before.tracker.disposeAll()

    // The replacement process: fresh lease, fresh tracker, same pane + WAL.
    const after = processWorld(file)
    // DispatchDeps.ownerComposing is what admission 409s on — the adopted
    // fact answers true although this process never saw a byte.
    expect(after.tracker.ownerComposing('term-1')).toBe(true)
    // And nothing weaker than a submit clears it: the fresh model never
    // watched the previous process's bytes, so Ctrl-U proves nothing.
    type(after, '\x15')
    expect(after.tracker.ownerComposing('term-1')).toBe(true)
    after.tracker.disposeAll()
  })

  it('paste-without-CR (cancelled delivery) → restart: contaminated, submits refused', async () => {
    vi.useFakeTimers()
    const file = walFile()
    const before = processWorld(file)
    let valid = true
    const writes: string[] = []
    const promise = pasteAndSubmit(
      before.session as unknown as PtySession,
      'the dispatched brief',
      (data) => writes.push(data),
      () => valid,
      before.lease
    )
    expect(writes).toHaveLength(1) // the paste went out…
    valid = false // …then the delivery died inside the delay window
    await vi.advanceTimersByTimeAsync(2000)
    await expect(promise).resolves.toBe('cancelled')
    before.tracker.disposeAll()
    vi.useRealTimers()

    const after = processWorld(file)
    expect(after.lease.isContaminated('term-1')).toBe(true)
    expect(after.tracker.guardOwnerInput('term-1', 'retry\r')).toBe('refused')
    expect(after.tracker.refusalReason('term-1')).toContain('restart the terminal')
    after.tracker.disposeAll()
  })

  it('type → submit → restart: the observed submit cleared the fact durably', () => {
    const file = walFile()
    const before = processWorld(file)
    type(before, 'deploy the release')
    type(before, '\r')
    expect(before.tracker.ownerComposing('term-1')).toBe(false)
    before.tracker.disposeAll()

    const after = processWorld(file)
    expect(after.store.recordOf('term-1')).toBeNull()
    expect(after.tracker.ownerComposing('term-1')).toBe(false)
    after.tracker.disposeAll()
  })

  it('retire clears durably — the pane died with its box', () => {
    const file = walFile()
    const before = processWorld(file)
    type(before, 'doomed typing')
    before.lease.retire('term-1')
    before.tracker.disposeAll()

    const after = processWorld(file)
    expect(after.store.recordOf('term-1')).toBeNull()
    expect(after.tracker.ownerComposing('term-1')).toBe(false)
    after.tracker.disposeAll()
  })

  it('retireAll (app shutdown) does NOT clear the WAL — the panes survive the quit', () => {
    const file = walFile()
    const before = processWorld(file)
    type(before, 'typing at quit time')
    before.lease.retireAll()
    // In-memory state died with the generations…
    expect(before.lease.generationOf('term-1')).toBe(1)
    expect(before.lease.isOwnerEditing('term-1')).toBe(false)
    before.tracker.disposeAll()

    // …but the durable fact survives for the next process to adopt.
    const after = processWorld(file)
    expect(after.tracker.ownerComposing('term-1')).toBe(true)
    after.tracker.disposeAll()
  })

  it("a dispatch delivery's own observed submit settles the fact it recorded", () => {
    const file = walFile()
    const before = processWorld(file)
    type(before, '\x1b[200~the dispatched brief\x1b[201~', 'dispatch')
    expect(before.store.recordOf('term-1')).toBe('dirty')
    type(before, '\r', 'dispatch')
    // Consumed wholesale: the durable dirty fact is gone, so a crash AFTER a
    // completed pty-fallback dispatch never false-dirties the terminal.
    expect(before.store.recordOf('term-1')).toBeNull()
    before.tracker.disposeAll()

    const after = processWorld(file)
    expect(after.tracker.ownerComposing('term-1')).toBe(false)
    after.tracker.disposeAll()
  })

  it('seedLive adopts a cold detached terminal at first sight', () => {
    const file = walFile()
    new InputProvenanceStore(file).markDirty('cold-term')
    const store = new InputProvenanceStore(file)
    const lease = new ProducerLease(store)
    lease.seedLive(['cold-term', 'clean-term'])
    expect(lease.isOwnerEditing('cold-term')).toBe(true)
    // No record adopts clean — absence is evidence (every write was WAL-first).
    expect(lease.isOwnerEditing('clean-term')).toBe(false)
    expect(lease.isContaminated('clean-term')).toBe(false)
  })

  it('the false-dirty asymmetry: WAL mark with no byte written resolves by the normal clears', () => {
    // Crash between the WAL mark and proc.write: the pane never received the
    // byte, but the record says dirty. The next process adopts fail-closed —
    // one observed submit clears it, exactly like real residue.
    const file = walFile()
    new InputProvenanceStore(file).markDirty('term-1')

    const after = processWorld(file)
    expect(after.tracker.ownerComposing('term-1')).toBe(true)
    type(after, 'go\r')
    expect(after.tracker.ownerComposing('term-1')).toBe(false)
    expect(after.store.recordOf('term-1')).toBeNull()
    after.tracker.disposeAll()
  })

  it('an adopted contaminated fact outlasts owner-editing clears, until retire', () => {
    const file = walFile()
    new InputProvenanceStore(file).markContaminated('term-1')
    const after = processWorld(file)
    expect(after.lease.isContaminated('term-1')).toBe(true)
    // clearOwnerEditing must not settle the stronger durable fact.
    after.lease.clearOwnerEditing('term-1')
    expect(after.store.recordOf('term-1')).toBe('contaminated')
    expect(after.lease.isContaminated('term-1')).toBe(true)
    after.lease.retire('term-1')
    expect(after.store.recordOf('term-1')).toBeNull()
    expect(after.lease.isContaminated('term-1')).toBe(false)
    after.tracker.disposeAll()
  })
})
