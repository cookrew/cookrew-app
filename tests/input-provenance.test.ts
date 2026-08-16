// Sol r10 P0-1 / r11 P0-1,2,3 + P1 — the input-provenance WAL. Panes outlive
// the process, so the facts protecting their input boxes must too: recorded
// ATOMICALLY-DURABLY before any byte or paste crosses the pane boundary (a
// mark that cannot commit REFUSES the write), carrying the PRODUCER identity,
// and cleared only by a downstream witness — the transcript landing the
// consuming turn — the one proven single-line erase, or PROVEN pane death.
// The local input echo is never the witness. Absence of a record adopts
// CLEAN on a clean load, because every dirtying write was WAL-first; an
// unreadable/corrupt WAL adopts EVERY pane dirty, fail-closed.

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InputProvenanceStore, dirtiesInputBox, pastedBodyOf } from '../src/main/input-provenance'
import { ProducerLease, DISPATCH_RESIDUE_REFUSAL } from '../src/main/producer-lease'
import { TurnTracker } from '../src/main/turn-tracker'
import { pasteAndSubmit } from '../src/main/ask'
import type { TurnRecord } from '../src/shared/turn'
import type { PtySession } from '../src/main/pty'

const walDir = (): string => mkdtempSync(path.join(tmpdir(), 'cookrew-wal-'))
const walFile = (): string => path.join(walDir(), 'input-provenance.json')

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
): boolean {
  const committed =
    source === 'dispatch'
      ? world.lease.noteDispatchBytesEntering(world.session.terminalId, data)
      : world.lease.noteBytesEntering(world.session.terminalId, data)
  if (!committed) return false
  world.session.emit('input', data, source)
  return true
}

/** A durable transcript record — what the session-file reconcile lands. */
function transcriptRecord(overrides: Partial<TurnRecord> = {}): TurnRecord {
  const startedAt = overrides.startedAt ?? Date.now()
  return {
    index: 1,
    prompt: 'deploy the release',
    reply: 'done',
    uuid: 'uuid-1',
    startedAt,
    endedAt: startedAt + 100,
    final: true,
    ...overrides
  }
}

describe('InputProvenanceStore — durable write-ahead semantics', () => {
  it('markDirty is synchronous-durable: a NEW store on the same file sees it', () => {
    const file = walFile()
    const store = new InputProvenanceStore(file)
    expect(store.markDirty('term-1')).toBe(true)
    // The WAL guarantee: by the time markDirty returns true, the fact is on disk.
    expect(new InputProvenanceStore(file).recordOf('term-1')).toBe('owner-dirty')
  })

  it('strength order: contaminated > dispatch-delivery > owner-dirty, never downgraded', () => {
    const file = walFile()
    const store = new InputProvenanceStore(file)
    store.markDirty('term-1')
    store.markDispatchDelivery('term-1', 'the brief')
    expect(store.recordOf('term-1')).toBe('dispatch-delivery')
    store.markDirty('term-1')
    expect(store.recordOf('term-1')).toBe('dispatch-delivery')
    store.markContaminated('term-1')
    store.markDispatchDelivery('term-1', 'another brief')
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
    expect(next.takeAdoptable('term-1')).toBe('owner-dirty')
    expect(next.takeAdoptable('term-1')).toBeNull()
    // The record itself stands until a real clear.
    expect(next.recordOf('term-1')).toBe('owner-dirty')
  })

  it('facts marked in THIS process are not adoptable — adoption is for dying words only', () => {
    const store = new InputProvenanceStore(walFile())
    store.markDirty('term-1')
    expect(store.takeAdoptable('term-1')).toBeNull()
  })

  it('persists as an atomic durable JSON file (v2, producer-qualified kinds)', () => {
    const file = walFile()
    const store = new InputProvenanceStore(file)
    store.markDispatchDelivery('term-1', 'the delivered brief')
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      version: number
      boxes: Record<string, { kind: string; prompt?: string }>
    }
    expect(parsed.version).toBe(2)
    expect(parsed.boxes['term-1'].kind).toBe('dispatch-delivery')
    expect(parsed.boxes['term-1'].prompt).toBe('the delivered brief')
  })

  it('still adopts the r10 v1 shape: dirty → owner-dirty, contaminated intact', () => {
    const file = walFile()
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        boxes: {
          'term-a': { fact: 'dirty', markedAt: 123 },
          'term-b': { fact: 'contaminated', markedAt: 456 }
        }
      })
    )
    const store = new InputProvenanceStore(file)
    expect(store.loadFaulted()).toBe(false)
    expect(store.takeAdoptable('term-a')).toBe('owner-dirty')
    expect(store.takeAdoptable('term-b')).toBe('contaminated')
  })
})

// ---------------------------------------------------------------------------
// Sol r11 P0-1 — the WAL fails CLOSED: a mark that cannot commit refuses the
// pane write, failed state is retried, and an unreadable file adopts every
// pane dirty instead of clean.
// ---------------------------------------------------------------------------

describe('WAL storage faults fail closed (Sol r11 P0-1)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('a persist that cannot commit returns false — and the refusal reaches pasteAndSubmit', async () => {
    const dir = walDir()
    const file = path.join(dir, 'input-provenance.json')
    const store = new InputProvenanceStore(file)
    const lease = new ProducerLease(store)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    chmodSync(dir, 0o500) // the atomic write's temp file cannot be created
    try {
      expect(store.markDirty('term-1')).toBe(false)
      expect(errors).toHaveBeenCalled()
      // The primitive that owns the paste window refuses BEFORE any byte:
      // 'cancelled' with zero writes — nothing crossed unprotected.
      const writes: string[] = []
      const session = { terminalId: 'term-1', write: (d: string) => writes.push(d) }
      await expect(
        pasteAndSubmit(session as unknown as PtySession, 'the brief', undefined, undefined, lease)
      ).resolves.toBe('cancelled')
      expect(writes).toEqual([])
    } finally {
      chmodSync(dir, 0o700)
    }
    // Failed state was PRESERVED and retries once the disk returns: the very
    // next mark commits the fact that was refused above.
    expect(store.markDirty('term-1')).toBe(true)
    expect(new InputProvenanceStore(file).recordOf('term-1')).toBe('owner-dirty')
  })

  it('an unreadable (corrupt) WAL adopts EVERY live pane dirty, out loud', () => {
    const file = walFile()
    writeFileSync(file, '{not json')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const store = new InputProvenanceStore(file)
    expect(store.loadFaulted()).toBe(true)
    expect(errors).toHaveBeenCalled()
    const lease = new ProducerLease(store)
    // Seeding at boot is first sight for every known pane: all adopt dirty.
    lease.seedLive(['pane-1', 'pane-2'])
    expect(lease.isOwnerEditing('pane-1')).toBe(true)
    expect(lease.isOwnerEditing('pane-2')).toBe(true)
    // And the rebuilt protection is durable again — the next process adopts
    // the same fail-closed facts from a now-valid file.
    const next = new InputProvenanceStore(file)
    expect(next.loadFaulted()).toBe(false)
    expect(next.recordOf('pane-1')).toBe('owner-dirty')
  })

  it('ENOENT is a clean first run — every box adopts clean', () => {
    const store = new InputProvenanceStore(walFile())
    expect(store.loadFaulted()).toBe(false)
    const lease = new ProducerLease(store)
    lease.seedLive(['pane-1'])
    expect(lease.isOwnerEditing('pane-1')).toBe(false)
    expect(lease.isContaminated('pane-1')).toBe(false)
  })

  it('a crash-torn temp file leaves the prior facts intact (rename is atomic)', () => {
    const file = walFile()
    new InputProvenanceStore(file).markContaminated('term-1')
    // The previous process died mid-persist: a torn temp sits beside the
    // last durably renamed truth.
    writeFileSync(`${file}.tmp`, '{"version":2,"boxes":{"term-')
    const store = new InputProvenanceStore(file)
    expect(store.loadFaulted()).toBe(false)
    expect(store.recordOf('term-1')).toBe('contaminated')
    // And the stale temp cannot poison the next persist either.
    store.markDirty('term-2')
    expect(new InputProvenanceStore(file).recordOf('term-2')).toBe('owner-dirty')
  })
})

describe('dirtiesInputBox — every content-bearing chunk marks', () => {
  it('typed text, pastes and split markers dirty the box', () => {
    expect(dirtiesInputBox('a')).toBe(true)
    expect(dirtiesInputBox('   ')).toBe(true) // whitespace is real bytes
    expect(dirtiesInputBox('\x1b[200~pasted\x1b[201~')).toBe(true)
    expect(dirtiesInputBox('\x1b[200~still open')).toBe(true)
    expect(dirtiesInputBox('\x1b[20')).toBe(true) // withheld partial marker
    expect(dirtiesInputBox('abc\rdef')).toBe(true) // bytes past the submit
  })

  it('submit-carrying content chunks mark too — enqueue is not consumption (r11 P0-2)', () => {
    // proc.write is an asynchronous enqueue: the process can die after 'abc'
    // crossed while the CR never did, so a self-contained submit is NOT clean.
    expect(dirtiesInputBox('abc\r')).toBe(true)
    expect(dirtiesInputBox('\x1b[200~multi\nline\x1b[201~\r')).toBe(true)
  })

  it('navigation, interrupts and content-free chunks do not', () => {
    expect(dirtiesInputBox('\x1b[<64;10;10M')).toBe(false) // SGR wheel
    expect(dirtiesInputBox('\x1b[A')).toBe(false) // arrow
    expect(dirtiesInputBox('\x1b')).toBe(false) // bare ESC = interrupt key
    expect(dirtiesInputBox('\r')).toBe(false) // empty submit adds nothing
    expect(dirtiesInputBox('\x15')).toBe(false) // kill-line adds nothing
  })

  it('pastedBodyOf strips the bracketed markers to the delivered bytes', () => {
    expect(pastedBodyOf('\x1b[200~the brief\x1b[201~')).toBe('the brief')
    expect(pastedBodyOf('bare bytes')).toBe('bare bytes')
  })
})

// ---------------------------------------------------------------------------
// The restart matrix: same WAL file, fresh store + lease + tracker — the
// simulated process replacement the r10/r11 P0s name.
// ---------------------------------------------------------------------------

describe('input provenance across process replacement', () => {
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
    // And nothing weaker than a witness clears it: the fresh model never
    // watched the previous process's bytes, so Ctrl-U proves nothing.
    type(after, '\x15')
    expect(after.tracker.ownerComposing('term-1')).toBe(true)
    after.tracker.disposeAll()
  })

  it('a submit-carrying chunk marks, and the LOCAL echo does not clear the record (r11 P0-2)', () => {
    const file = walFile()
    const before = processWorld(file)
    type(before, 'deploy the release\r')
    // The in-memory model saw its own submit — composing drops for this
    // process — but the durable fact stands: the echo is an enqueue
    // observation, and the CR may never have crossed the async PTY write.
    expect(before.tracker.ownerComposing('term-1')).toBe(false)
    expect(before.store.recordOf('term-1')).toBe('owner-dirty')
    before.tracker.disposeAll()

    // Crash before any transcript record landed → the box adopts DIRTY.
    const after = processWorld(file)
    expect(after.tracker.ownerComposing('term-1')).toBe(true)
    after.tracker.disposeAll()
  })

  it('the TRANSCRIPT witness clears: a reconciled turn at/after the mark settles the fact', () => {
    const file = walFile()
    const before = processWorld(file)
    type(before, 'deploy the release')
    type(before, '\r')
    expect(before.store.recordOf('term-1')).toBe('owner-dirty')
    // The session-file observer lands the consuming turn — the downstream
    // proof the local echo can never be.
    before.tracker.replaceHistory('term-1', [transcriptRecord({ startedAt: Date.now() + 50 })])
    expect(before.store.recordOf('term-1')).toBeNull()
    before.tracker.disposeAll()

    const after = processWorld(file)
    expect(after.tracker.ownerComposing('term-1')).toBe(false)
    after.tracker.disposeAll()
  })

  it('a transcript record from BEFORE the mark witnesses nothing', () => {
    const file = walFile()
    const world = processWorld(file)
    const past = Date.now() - 60_000
    type(world, 'queued bytes typed during an old turn\r')
    world.tracker.replaceHistory('term-1', [
      transcriptRecord({ startedAt: past, endedAt: past + 100 })
    ])
    // The old turn was already running when the mark landed — it cannot
    // vouch for bytes that entered after it opened.
    expect(world.store.recordOf('term-1')).toBe('owner-dirty')
    world.tracker.disposeAll()
  })

  it('bytes typed AFTER a submit re-stamp the mark: the earlier submit cannot clear them', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const file = walFile()
    const world = processWorld(file)
    type(world, 'first prompt\r') // marked at t0, submit observed locally
    vi.setSystemTime(1_005_000)
    type(world, 'second draft, never submitted') // re-stamps markedAt to t1
    // The transcript lands the FIRST submit's turn (opened between t0 and t1):
    // it must NOT clear the fact protecting the second draft.
    world.tracker.replaceHistory('term-1', [
      transcriptRecord({ startedAt: 1_002_000, endedAt: 1_002_500 })
    ])
    expect(world.store.recordOf('term-1')).toBe('owner-dirty')
    world.tracker.disposeAll()
    vi.useRealTimers()
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

  it('the false-dirty asymmetry: WAL mark with no byte written resolves by the witness', () => {
    // Crash between the WAL mark and proc.write: the pane never received the
    // byte, but the record says dirty. The next process adopts fail-closed —
    // its transcript witness (or proven pane death) clears it.
    const file = walFile()
    new InputProvenanceStore(file).markDirty('term-1')

    const after = processWorld(file)
    expect(after.tracker.ownerComposing('term-1')).toBe(true)
    type(after, 'go\r')
    // Locally observed submit drops the composing mark…
    expect(after.tracker.ownerComposing('term-1')).toBe(false)
    // …and the transcript landing the turn settles the record.
    after.tracker.replaceHistory('term-1', [transcriptRecord({ startedAt: Date.now() + 10 })])
    expect(after.store.recordOf('term-1')).toBeNull()
    after.tracker.disposeAll()
  })

  it('an adopted contaminated fact outlasts every witness, until proven pane death', () => {
    const file = walFile()
    new InputProvenanceStore(file).markContaminated('term-1')
    const after = processWorld(file)
    expect(after.lease.isContaminated('term-1')).toBe(true)
    after.lease.clearOwnerEditing('term-1')
    after.tracker.replaceHistory('term-1', [transcriptRecord({ startedAt: Date.now() + 10 })])
    expect(after.store.recordOf('term-1')).toBe('contaminated')
    expect(after.lease.isContaminated('term-1')).toBe(true)
    after.lease.retire('term-1')
    after.lease.clearProvenanceOnDeath('term-1')
    expect(after.store.recordOf('term-1')).toBeNull()
    expect(after.lease.isContaminated('term-1')).toBe(false)
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

  it('the proven single-line erase still clears durably', () => {
    const file = walFile()
    const world = processWorld(file)
    type(world, 'typed then erased')
    expect(world.store.recordOf('term-1')).toBe('owner-dirty')
    type(world, '\x15') // Ctrl-U on the fully watched single line
    expect(world.store.recordOf('term-1')).toBeNull()
    expect(world.tracker.ownerComposing('term-1')).toBe(false)
    world.tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r11 P0-3 — dispatch residue keeps its producer identity. A dispatch
// paste stranded by a crash blocks EVERY submit-capable producer on restart,
// clears only when the transcript witnesses the delivered prompt consumed,
// and hardens to contamination at shutdown or on a failed kill.
// ---------------------------------------------------------------------------

describe('dispatch-delivery residue (Sol r11 P0-3)', () => {
  const BRIEF = 'the dispatched brief'
  const PASTE = `\x1b[200~${BRIEF}\x1b[201~`

  it('the paste marks producer-qualified, and blocks owner AND dispatch in-process', () => {
    const file = walFile()
    const world = processWorld(file)
    type(world, PASTE, 'dispatch')
    expect(world.store.recordOf('term-1')).toBe('dispatch-delivery')
    // The everyone-blocking residue: owner submits refuse at the guard, and
    // the dispatch legs' own isContaminated check refuses a second delivery.
    expect(world.tracker.guardOwnerInput('term-1', 'mine\r')).toBe('refused')
    expect(world.lease.isContaminated('term-1')).toBe(true)
    expect(world.lease.hasDispatchResidue('term-1')).toBe(true)
    expect(world.tracker.refusalReason('term-1')).toBe(DISPATCH_RESIDUE_REFUSAL)
    world.tracker.disposeAll()
  })

  it('death after paste, before CR → restart: owner submit refused AND dispatch refused', () => {
    const file = walFile()
    const before = processWorld(file)
    type(before, PASTE, 'dispatch')
    // The process dies here — no CR, no upgrade, no witness.
    before.tracker.disposeAll()

    const after = processWorld(file)
    // Producer identity survived: not a mere owner-editing mark.
    expect(after.lease.hasDispatchResidue('term-1')).toBe(true)
    // Owner Enter beside the dead dispatch's brief is refused…
    expect(after.tracker.guardOwnerInput('term-1', 'looks done, ship it\r')).toBe('refused')
    // …and so is another delivery (the legs consult isContaminated).
    expect(after.lease.isContaminated('term-1')).toBe(true)
    after.tracker.disposeAll()
  })

  it('the CR echo alone does NOT clear — the transcript witnessing the brief consumed does', () => {
    const file = walFile()
    const world = processWorld(file)
    type(world, PASTE, 'dispatch')
    type(world, '\r', 'dispatch')
    // Locally observed CR: still only an enqueue observation.
    expect(world.store.recordOf('term-1')).toBe('dispatch-delivery')
    expect(world.lease.hasDispatchResidue('term-1')).toBe(true)
    // The transcript lands the delivered prompt as a turn — the witness.
    world.tracker.replaceHistory('term-1', [
      transcriptRecord({ prompt: BRIEF, startedAt: Date.now() + 10 })
    ])
    expect(world.store.recordOf('term-1')).toBeNull()
    expect(world.lease.hasDispatchResidue('term-1')).toBe(false)
    expect(world.lease.isContaminated('term-1')).toBe(false)
    world.tracker.disposeAll()
  })

  it('the witness works across the restart too — the adopting process clears on its own reconcile', () => {
    const file = walFile()
    const before = processWorld(file)
    type(before, PASTE, 'dispatch')
    type(before, '\r', 'dispatch') // CR crossed, then the process died pre-witness
    before.tracker.disposeAll()

    const after = processWorld(file)
    expect(after.lease.hasDispatchResidue('term-1')).toBe(true)
    after.tracker.replaceHistory('term-1', [
      transcriptRecord({ prompt: BRIEF, startedAt: Date.now() + 10 })
    ])
    expect(after.store.recordOf('term-1')).toBeNull()
    expect(after.lease.hasDispatchResidue('term-1')).toBe(false)
    after.tracker.disposeAll()
  })

  it('owner bytes typed beside the residue keep their OWN protection past the witness', () => {
    const file = walFile()
    const world = processWorld(file)
    type(world, PASTE, 'dispatch')
    type(world, '\r', 'dispatch')
    // The guard admits non-submitting owner bytes while residue stands; they
    // enter the same shared box and did NOT ride the dispatch's submit.
    type(world, 'x')
    expect(world.tracker.ownerComposing('term-1')).toBe(true)
    // The transcript witnesses the DISPATCH prompt consumed…
    world.tracker.replaceHistory('term-1', [
      transcriptRecord({ prompt: BRIEF, startedAt: Date.now() + 10 })
    ])
    // …which clears the residue but must not orphan the owner's live byte:
    // the box is still dirty, durably.
    expect(world.lease.hasDispatchResidue('term-1')).toBe(false)
    expect(world.store.recordOf('term-1')).toBe('owner-dirty')
    expect(world.tracker.ownerComposing('term-1')).toBe(true)
    world.tracker.disposeAll()
  })

  it('shutdown upgrades an unresolved delivery to contamination (retireAll)', () => {
    const file = walFile()
    const before = processWorld(file)
    type(before, PASTE, 'dispatch')
    // Graceful quit: teardown cancelled the delivery — its witness will
    // never arrive in this process, so the paste is KNOWN stranded.
    before.lease.retireAll()
    expect(before.store.recordOf('term-1')).toBe('contaminated')
    before.tracker.disposeAll()

    const after = processWorld(file)
    expect(after.lease.isContaminated('term-1')).toBe(true)
    expect(after.lease.hasDispatchResidue('term-1')).toBe(false)
    after.tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r11 P1 — retirement is split: logical generation retirement is
// immediate, but the durable provenance clears ONLY on proven pane death.
// ---------------------------------------------------------------------------

describe('retirement vs proven pane death (Sol r11 P1)', () => {
  it('retire() keeps the WAL fact — the kill behind it has not been proven yet', () => {
    const file = walFile()
    const world = processWorld(file)
    type(world, 'doomed typing')
    world.lease.retire('term-1')
    // Stale holders are invisible (generation bumped), in-memory marks died…
    expect(world.lease.generationOf('term-1')).toBe(1)
    expect(world.lease.isOwnerEditing('term-1')).toBe(false)
    // …but the durable fact stands: the pane may have survived the kill.
    expect(world.store.recordOf('term-1')).toBe('owner-dirty')
    world.tracker.disposeAll()

    // A crash before the kill was proven adopts the box dirty, correctly.
    const after = processWorld(file)
    expect(after.tracker.ownerComposing('term-1')).toBe(true)
    after.tracker.disposeAll()
  })

  it('clearProvenanceOnDeath after retire clears durably — the proven-kill order', () => {
    const file = walFile()
    const world = processWorld(file)
    type(world, 'doomed typing')
    world.lease.retire('term-1')
    world.lease.clearProvenanceOnDeath('term-1') // killAndWait proved death
    expect(world.store.recordOf('term-1')).toBeNull()
    world.tracker.disposeAll()

    const after = processWorld(file)
    expect(after.tracker.ownerComposing('term-1')).toBe(false)
    after.tracker.disposeAll()
  })

  it('proven death BEFORE retire composes the same way (either order ends clean)', () => {
    const file = walFile()
    const world = processWorld(file)
    type(world, 'doomed typing')
    world.lease.clearProvenanceOnDeath('term-1')
    world.lease.retire('term-1')
    expect(world.store.recordOf('term-1')).toBeNull()
    expect(world.lease.isOwnerEditing('term-1')).toBe(false)
    world.tracker.disposeAll()
  })

  it('kill failure keeps the fact and upgrades dispatch residue fail-closed', () => {
    const file = walFile()
    const world = processWorld(file)
    type(world, '\x1b[200~the brief\x1b[201~', 'dispatch')
    world.lease.retire('term-1')
    // killAndWait threw: the pane survived with the paste still real.
    world.lease.noteKillFailed('term-1')
    expect(world.store.recordOf('term-1')).toBe('contaminated')
    expect(world.lease.isContaminated('term-1')).toBe(true)
    world.tracker.disposeAll()

    const after = processWorld(file)
    expect(after.lease.isContaminated('term-1')).toBe(true)
    after.tracker.disposeAll()
  })

  it('kill failure over plain owner typing keeps the dirty fact untouched', () => {
    const file = walFile()
    const world = processWorld(file)
    type(world, 'owner typing')
    world.lease.retire('term-1')
    world.lease.noteKillFailed('term-1')
    expect(world.store.recordOf('term-1')).toBe('owner-dirty')
    world.tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// The scrape fallback witness: a terminal with no session file settles its
// facts when the scrape watches the turn complete — otherwise a scrape-only
// dispatch target would hold its everyone-blocking residue until retirement.
// ---------------------------------------------------------------------------

describe('scrape-settled turn as the fallback witness (Sol r11 P0-2)', () => {
  it('retireAll (app shutdown) keeps plain owner-dirty facts for the next process', () => {
    const file = walFile()
    const before = processWorld(file)
    type(before, 'typing at quit time')
    before.lease.retireAll()
    expect(before.lease.generationOf('term-1')).toBe(1)
    expect(before.lease.isOwnerEditing('term-1')).toBe(false)
    before.tracker.disposeAll()

    // The pane survives the quit; the durable fact survives with it.
    const after = processWorld(file)
    expect(after.tracker.ownerComposing('term-1')).toBe(true)
    after.tracker.disposeAll()
  })
})
