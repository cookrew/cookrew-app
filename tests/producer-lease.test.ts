// Sol r6 P0-1 — the one-producer LEASE, not a point-in-time check — hardened
// per Sol r7:
//
// - P0-1: displacement is GONE. Once a dispatch holds the submission window
//   its bytes may already be irreversibly in flight; a committed ledger
//   interrupt cannot un-send them, so an owner acquiring against a
//   dispatch-held window is refused — never a takeover. A cancelled
//   fallback's stranded paste marks the terminal CONTAMINATED, and submits
//   refuse until the owner clears the box.
// - P1: holds are generation-scoped. `retire` bumps the terminal's
//   generation at every permanent ending; a dead generation's holder is
//   invisible to new acquirers and its late release is a no-op.
//
// This file pins the acquisition matrix, the generation lifecycle, the
// contamination state machine, and the tracker guard's byte refusals.

import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  ProducerLease,
  defaultProducerLease,
  ownerHolder,
  type ProducerHolder
} from '../src/main/producer-lease'
import { TurnTracker } from '../src/main/turn-tracker'
import type { PtySession } from '../src/main/pty'

const dispatchHolder = (dispatchId: string): ProducerHolder => ({ kind: 'dispatch', dispatchId })

describe('ProducerLease — the acquisition matrix', () => {
  it('a free terminal acquires, and holderOf reports the holder', () => {
    const lease = new ProducerLease()
    const owner = ownerHolder()
    expect(lease.holderOf('term-1')).toBeNull()
    expect(lease.acquire('term-1', owner)).toBe('acquired')
    expect(lease.holderOf('term-1')).toBe(owner)
  })

  it('dispatch vs owner-held: refused — a dispatch never displaces owner work', () => {
    const lease = new ProducerLease()
    const owner = ownerHolder()
    lease.acquire('term-1', owner)
    expect(lease.acquire('term-1', dispatchHolder('dsp-1'))).toBe('held-by-owner')
    expect(lease.holderOf('term-1')).toBe(owner)
  })

  it('owner vs dispatch-held: refused — displacement is gone (Sol r7 P0-1)', () => {
    // The r6 takeover treated a committed ledger interrupt as proof the
    // backend submission was undone. It never was: promptAgent had already
    // been invoked, and a fallback's paste may already sit in the TUI's
    // input box. The owner now waits for the holder's own release.
    const lease = new ProducerLease()
    const dispatch = dispatchHolder('dsp-1')
    lease.acquire('term-1', dispatch)
    const owner = ownerHolder()
    expect(lease.acquire('term-1', owner)).toBe('held-by-dispatch')
    expect(lease.holderOf('term-1')).toBe(dispatch)
    // Only the holder's release frees the window, and then the owner runs.
    lease.release('term-1', dispatch)
    expect(lease.acquire('term-1', owner)).toBe('acquired')
  })

  it('owner vs owner-held: refused honestly — nothing preempts an owner submission', () => {
    const lease = new ProducerLease()
    const first = ownerHolder()
    lease.acquire('term-1', first)
    expect(lease.acquire('term-1', ownerHolder())).toBe('held-by-owner')
    expect(lease.holderOf('term-1')).toBe(first)
  })

  it('reentrancy: the same holder re-acquires, and releases pair with acquires', () => {
    const lease = new ProducerLease()
    const dispatch = dispatchHolder('dsp-1')
    expect(lease.acquire('term-1', dispatch)).toBe('acquired')
    expect(lease.acquire('term-1', dispatch)).toBe('acquired')
    lease.release('term-1', dispatch)
    // One release of two: still held.
    expect(lease.holderOf('term-1')).toEqual(dispatch)
    lease.release('term-1', dispatch)
    expect(lease.holderOf('term-1')).toBeNull()
  })

  it('a DIFFERENT dispatch id is a different holder, not a reentrant one', () => {
    const lease = new ProducerLease()
    lease.acquire('term-1', dispatchHolder('dsp-1'))
    expect(lease.acquire('term-1', dispatchHolder('dsp-2'))).toBe('held-by-dispatch')
  })

  it('release-on-cancel: a stranger release is a no-op; the holder frees the window', () => {
    const lease = new ProducerLease()
    const dispatch = dispatchHolder('dsp-1')
    lease.acquire('term-1', dispatch)
    lease.release('term-1', ownerHolder())
    lease.release('term-1', dispatchHolder('dsp-2'))
    expect(lease.holderOf('term-1')).toEqual(dispatch)
    lease.release('term-1', dispatch)
    expect(lease.holderOf('term-1')).toBeNull()
    // Releasing a free terminal is harmless too.
    lease.release('term-1', dispatch)
    expect(lease.holderOf('term-1')).toBeNull()
  })

  it('terminals are independent leases', () => {
    const lease = new ProducerLease()
    lease.acquire('term-1', dispatchHolder('dsp-1'))
    expect(lease.acquire('term-2', ownerHolder())).toBe('acquired')
  })

  it('defaultProducerLease is ONE shared instance — the property serialization rests on', () => {
    expect(defaultProducerLease()).toBe(defaultProducerLease())
  })
})

// ---------------------------------------------------------------------------
// Sol r7 P1 — generation-scoped holds. A native promptAgent can outlive its
// terminal (an execFile settling only at the ask timeout); before retire, the
// dead leg's hold stranded the reborn terminal's window until that promise
// finally resolved.
// ---------------------------------------------------------------------------

describe('ProducerLease — retirement generations (Sol r7 P1)', () => {
  it('retire makes a stranded holder invisible to new acquirers', () => {
    const lease = new ProducerLease()
    const stale = dispatchHolder('dsp-old')
    lease.acquire('term-1', stale)
    lease.retire('term-1')
    // The dead generation's holder no longer holds anything…
    expect(lease.holderOf('term-1')).toBeNull()
    // …and the reborn terminal's producers acquire freely.
    expect(lease.acquire('term-1', ownerHolder())).toBe('acquired')
  })

  it('a late release from a dead generation is a no-op — even on an unclaimed window', () => {
    const lease = new ProducerLease()
    const stale = dispatchHolder('dsp-old')
    lease.acquire('term-1', stale)
    lease.retire('term-1')
    // The dead leg unwinds out of its promptAgent and releases into a
    // terminal nobody has re-claimed yet: nothing to free, nothing corrupted.
    lease.release('term-1', stale)
    expect(lease.holderOf('term-1')).toBeNull()
    expect(lease.acquire('term-1', ownerHolder())).toBe('acquired')
  })

  it('the pre-retire release cannot free a window acquired after retire (fresh holder)', () => {
    const lease = new ProducerLease()
    const stale = ownerHolder()
    lease.acquire('term-1', stale)
    lease.retire('term-1')
    const live = ownerHolder()
    lease.acquire('term-1', live)
    // The dead ask's finally fires late: holder mismatch AND dead
    // generation — the live hold stands.
    lease.release('term-1', stale)
    expect(lease.holderOf('term-1')).toBe(live)
  })

  it('an acquire pinned to a captured generation refuses after retire', () => {
    const lease = new ProducerLease()
    const generation = lease.generationOf('term-1')
    lease.retire('term-1')
    expect(lease.acquire('term-1', ownerHolder(), { generation })).toBe('retired')
    expect(lease.acquire('term-1', ownerHolder(), { generation: lease.generationOf('term-1') })).toBe(
      'acquired'
    )
  })

  it('generations are monotonic and per-terminal', () => {
    const lease = new ProducerLease()
    expect(lease.generationOf('term-1')).toBe(0)
    lease.retire('term-1')
    lease.retire('term-1')
    expect(lease.generationOf('term-1')).toBe(2)
    expect(lease.generationOf('term-2')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Sol r7 P0-1 — the contamination flag. A delivery cancelled AFTER its paste
// but BEFORE its CR leaves the cancelled prompt in the shared input box; the
// terminal's next submit — any producer's — would carry it.
// ---------------------------------------------------------------------------

describe('ProducerLease — contamination (Sol r7 P0-1)', () => {
  it('mark / observe / clear', () => {
    const lease = new ProducerLease()
    expect(lease.isContaminated('term-1')).toBe(false)
    lease.markContaminated('term-1')
    expect(lease.isContaminated('term-1')).toBe(true)
    expect(lease.isContaminated('term-2')).toBe(false)
    lease.clearContaminated('term-1')
    expect(lease.isContaminated('term-1')).toBe(false)
  })

  it('retire clears contamination — the residue died with the process', () => {
    const lease = new ProducerLease()
    lease.markContaminated('term-1')
    lease.retire('term-1')
    expect(lease.isContaminated('term-1')).toBe(false)
  })

  it('a stale-generation mark no-ops — a retire that raced the cancellation wins', () => {
    // pasteAndSubmit captures the generation BEFORE its paste; if the
    // terminal is retired inside the delay window, the residue went into a
    // dead process's input box and must not stain the reborn terminal.
    const lease = new ProducerLease()
    const generation = lease.generationOf('term-1')
    lease.retire('term-1')
    lease.markContaminated('term-1', generation)
    expect(lease.isContaminated('term-1')).toBe(false)
    // A current-generation mark still lands.
    lease.markContaminated('term-1', lease.generationOf('term-1'))
    expect(lease.isContaminated('term-1')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The tracker guard's lease half (Sol r7 P0-1/P0-2): while ANY producer holds
// the submission window, untagged bytes refuse — the holder's own bytes
// travel the tagged writeFromOwner/writeFromDispatch paths. Owner takeover of
// a dispatch-HELD window is gone; preemption survives only for the ARMED
// (stamped, not delivering) dispatch, which never crossed the boundary.
// ---------------------------------------------------------------------------

class FakeSession extends EventEmitter {
  terminalId = 'term-1'
  full = ''
  idle = 0
  fullText(): string {
    return this.full
  }
  viewportText(): string {
    return this.full
  }
  idleFor(): number {
    return this.idle
  }
}

function guardFixture(): { tracker: TurnTracker; lease: ProducerLease; session: FakeSession } {
  const lease = new ProducerLease()
  const tracker = new TurnTracker(async () => null, null, lease)
  const session = new FakeSession()
  tracker.track(session as unknown as PtySession, true)
  return { tracker, lease, session }
}

describe('guardOwnerInput while a producer holds the lease', () => {
  it('refuses EVERY untagged byte while a dispatch delivery holds the window', () => {
    const { tracker, lease } = guardFixture()
    tracker.noteDispatch('term-1', 'dsp-1', 'the brief')
    lease.acquire('term-1', dispatchHolder('dsp-1'))
    // Typing, a bare Enter — and, new in r7, a SUBMITTING owner write: the
    // takeover is gone, because the delivery's bytes are already in flight.
    expect(tracker.guardOwnerInput('term-1', 'owner typing')).toBe('refused')
    expect(tracker.guardOwnerInput('term-1', '\r')).toBe('refused')
    expect(tracker.guardOwnerInput('term-1', 'an owner ask\r')).toBe('refused')
    tracker.disposeAll()
  })

  it('a SUBMITTING owner write no longer preempts a dispatch-HELD window (Sol r7 P0-1)', () => {
    const { tracker, lease } = guardFixture()
    tracker.noteDispatch('term-1', 'dsp-1', 'the brief')
    lease.acquire('term-1', dispatchHolder('dsp-1'))
    let preempts = 0
    tracker.onOwnerPreempt = () => {
      preempts += 1
      return true
    }
    expect(tracker.guardOwnerInput('term-1', 'an owner ask\r')).toBe('refused')
    // The interrupt path was never invoked: nothing bookkept a submission
    // that could not be un-sent.
    expect(preempts).toBe(0)
    tracker.disposeAll()
  })

  it('an OWNER-held window refuses untagged bytes too (Sol r7 P0-2)', () => {
    // While a typed/native ask holds the lease, renderer/mobile bytes used
    // to pass (`kind === 'dispatch'` check only) and could interleave with
    // the owner's paste. The holder's own bytes travel writeFromOwner, so
    // everything arriving at the guard is a second producer's.
    const { tracker, lease } = guardFixture()
    lease.acquire('term-1', ownerHolder())
    expect(tracker.guardOwnerInput('term-1', 'other typing')).toBe('refused')
    expect(tracker.guardOwnerInput('term-1', 'another ask\r')).toBe('refused')
    tracker.disposeAll()
  })

  it('a lease held with NO armed stamp left is a leg still unwinding — refuse', () => {
    const { tracker, lease } = guardFixture()
    lease.acquire('term-1', dispatchHolder('dsp-1'))
    expect(tracker.guardOwnerInput('term-1', 'an owner ask\r')).toBe('refused')
    tracker.disposeAll()
  })

  it('an UNTRACKED terminal under a held lease refuses too', () => {
    const lease = new ProducerLease()
    const tracker = new TurnTracker(async () => null, null, lease)
    lease.acquire('term-9', dispatchHolder('dsp-1'))
    expect(tracker.guardOwnerInput('term-9', 'anything\r')).toBe('refused')
  })

  it('ARMED but not delivering is unchanged: typing passes, only submits preempt', () => {
    const { tracker } = guardFixture()
    tracker.noteDispatch('term-1', 'dsp-1', 'the brief')
    // No lease hold: the dispatch is stamped but no delivery is writing.
    expect(tracker.guardOwnerInput('term-1', 'owner typing, no enter')).toBe('allow')
    let preempts = 0
    tracker.onOwnerPreempt = () => {
      preempts += 1
      return true
    }
    expect(tracker.guardOwnerInput('term-1', 'an owner ask\r')).toBe('allow')
    expect(preempts).toBe(1)
    tracker.disposeAll()
  })

  it('an uncommitted ARMED preemption still refuses the submit (fail-closed)', () => {
    const { tracker } = guardFixture()
    tracker.noteDispatch('term-1', 'dsp-1', 'the brief')
    tracker.onOwnerPreempt = () => false
    expect(tracker.guardOwnerInput('term-1', 'an owner ask\r')).toBe('preempt-failed')
    tracker.disposeAll()
  })
})

describe('guardOwnerInput under contamination (Sol r7 P0-1)', () => {
  it('refuses submit-capable bytes, allows non-submitting ones', () => {
    const { tracker, lease } = guardFixture()
    lease.markContaminated('term-1')
    // A submit — even an empty menu Enter — sends whatever the box holds,
    // and the box holds a cancelled producer's paste.
    expect(tracker.guardOwnerInput('term-1', 'a new prompt\r')).toBe('refused')
    expect(tracker.guardOwnerInput('term-1', '\r')).toBe('refused')
    // Typing and editing keys pass: the owner must be able to clear the box.
    expect(tracker.guardOwnerInput('term-1', 'typing')).toBe('allow')
    expect(tracker.guardOwnerInput('term-1', '\x15')).toBe('allow')
    tracker.disposeAll()
  })

  it('an owner line-clear (Ctrl-U / Ctrl-C) through the input path clears the flag', () => {
    const { tracker, lease, session } = guardFixture()
    lease.markContaminated('term-1')
    expect(tracker.guardOwnerInput('term-1', 'retry\r')).toBe('refused')
    // The acknowledgment: the owner clears the box with their own keys. The
    // bytes are non-submitting, so the guard passes them, and handleInput —
    // the delivered-bytes side — clears the flag.
    session.emit('input', '\x15')
    expect(lease.isContaminated('term-1')).toBe(false)
    expect(tracker.guardOwnerInput('term-1', 'retry\r')).toBe('allow')
    tracker.disposeAll()
  })

  it("a dispatch's OWN tagged bytes never count as the owner's acknowledgment", () => {
    const { tracker, lease, session } = guardFixture()
    lease.markContaminated('term-1')
    session.emit('input', '\x15', 'dispatch')
    expect(lease.isContaminated('term-1')).toBe(true)
    tracker.disposeAll()
  })
})
