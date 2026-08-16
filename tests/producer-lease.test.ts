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

describe('ProducerLease — contamination (Sol r7 P0-1, fail-closed per r8 P0-2)', () => {
  it('mark / observe — and there is NO clear operation on the lease', () => {
    const lease = new ProducerLease()
    expect(lease.isContaminated('term-1')).toBe(false)
    lease.markContaminated('term-1')
    expect(lease.isContaminated('term-1')).toBe(true)
    expect(lease.isContaminated('term-2')).toBe(false)
    // The r7 clearContaminated is deleted: converting an observed control
    // byte into proof of a clean box readmitted submits over live residue.
    expect(
      (lease as unknown as Record<string, unknown>).clearContaminated
    ).toBeUndefined()
  })

  it('retire — the ONLY clear: the residue died with the process', () => {
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

describe('guardOwnerInput under contamination (Sol r7 P0-1, fail-closed per r8 P0-2)', () => {
  it('refuses submit-capable bytes, allows non-submitting ones', () => {
    const { tracker, lease } = guardFixture()
    lease.markContaminated('term-1')
    // A submit — even an empty menu Enter — sends whatever the box holds,
    // and the box holds a cancelled producer's paste.
    expect(tracker.guardOwnerInput('term-1', 'a new prompt\r')).toBe('refused')
    expect(tracker.guardOwnerInput('term-1', '\r')).toBe('refused')
    // Editing keys still pass: they are harmless in a box nothing can
    // submit from, and dropping them would make the terminal feel dead.
    expect(tracker.guardOwnerInput('term-1', 'typing')).toBe('allow')
    expect(tracker.guardOwnerInput('term-1', '\x15')).toBe('allow')
    tracker.disposeAll()
  })

  it('control bytes do NOT clear the flag — an observation is not proof (r8 P0-2)', () => {
    // The r7 rule took one observed Ctrl-U/Ctrl-C as the owner's
    // acknowledgment of a clean box — but Ctrl-U provably clears ONE line of
    // a multi-line residue and Ctrl-C doubles as interrupt/quit per harness,
    // so the next submit could still carry cancelled consumer text under a
    // fresh producer identity.
    const { tracker, lease, session } = guardFixture()
    lease.markContaminated('term-1')
    expect(tracker.guardOwnerInput('term-1', 'retry\r')).toBe('refused')
    session.emit('input', '\x15')
    session.emit('input', '\x03')
    expect(lease.isContaminated('term-1')).toBe(true)
    expect(tracker.guardOwnerInput('term-1', 'retry\r')).toBe('refused')
    // The named refusal tells the owner the one real remedy.
    expect(tracker.refusalReason('term-1')).toContain('restart the terminal')
    tracker.disposeAll()
  })

  it('terminal retirement — the generation reset — is what clears it', () => {
    const { tracker, lease, session } = guardFixture()
    lease.markContaminated('term-1')
    session.emit('input', '\x15')
    expect(lease.isContaminated('term-1')).toBe(true)
    lease.retire('term-1')
    expect(lease.isContaminated('term-1')).toBe(false)
    expect(tracker.guardOwnerInput('term-1', 'retry\r')).toBe('allow')
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r8 P0-1 — input-buffer ownership. Typing is not a submission, so the
// lease never saw it: real owner text could sit in the shared input box while
// a dispatch acquired the free lease and submitted the combined principal
// input. The editing reservation marks the box as the owner's from the first
// meaningful byte, and ownerComposing is the question dispatch admission and
// both delivery legs ask.
// ---------------------------------------------------------------------------

describe('ProducerLease — the owner-editing mark (Sol r8 P0-1)', () => {
  it('mark / observe / clear', () => {
    const lease = new ProducerLease()
    expect(lease.isOwnerEditing('term-1')).toBe(false)
    lease.markOwnerEditing('term-1')
    expect(lease.isOwnerEditing('term-1')).toBe(true)
    expect(lease.isOwnerEditing('term-2')).toBe(false)
    lease.clearOwnerEditing('term-1')
    expect(lease.isOwnerEditing('term-1')).toBe(false)
  })

  it('is a mark, not a hold: the lease stays acquirable by the owner themselves', () => {
    const lease = new ProducerLease()
    lease.markOwnerEditing('term-1')
    expect(lease.acquire('term-1', ownerHolder())).toBe('acquired')
  })

  it('retire clears it — the typing died with the process', () => {
    const lease = new ProducerLease()
    lease.markOwnerEditing('term-1')
    lease.retire('term-1')
    expect(lease.isOwnerEditing('term-1')).toBe(false)
  })

  it('a stale-generation mark no-ops, like contamination', () => {
    const lease = new ProducerLease()
    const generation = lease.generationOf('term-1')
    lease.retire('term-1')
    lease.markOwnerEditing('term-1', generation)
    expect(lease.isOwnerEditing('term-1')).toBe(false)
  })
})

describe('TurnTracker.ownerComposing (Sol r8 P0-1)', () => {
  it('typed owner bytes compose; a submit consumes the buffer and releases', () => {
    const { tracker, session } = guardFixture()
    expect(tracker.ownerComposing('term-1')).toBe(false)
    session.emit('input', 'deploy the rel')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    // Submit completion: the buffer empties through the same feed.
    session.emit('input', 'ease\r')
    expect(tracker.ownerComposing('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('single-line typed-then-Ctrl-U clears — the ONE proven clear op (Sol r9 P0-2)', () => {
    // The model watched every byte of this line being typed, the buffer
    // never left one line, and a Ctrl-U on that single watched line is
    // proven byte-by-byte for the harnesses we host. This is the only
    // control-byte clear; everything multiline/unknown keeps the mark.
    const { tracker, session } = guardFixture()
    session.emit('input', 'half a thought')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    session.emit('input', '\x15')
    expect(tracker.ownerComposing('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it("a dispatch's OWN tagged paste never reads as the owner composing", () => {
    const { tracker, session } = guardFixture()
    session.emit('input', '\x1b[200~the dispatched brief\x1b[201~', 'dispatch')
    expect(tracker.ownerComposing('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('an owner-held lease composes too — its paste is mid-flight toward the box', () => {
    const { tracker, lease } = guardFixture()
    const owner = ownerHolder()
    lease.acquire('term-1', owner)
    expect(tracker.ownerComposing('term-1')).toBe(true)
    lease.release('term-1', owner)
    expect(tracker.ownerComposing('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('terminal retirement releases the reservation with everything else', () => {
    const { tracker, lease, session } = guardFixture()
    session.emit('input', 'typing at the point of death')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    lease.retire('term-1')
    expect(tracker.ownerComposing('term-1')).toBe(false)
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r9 P0-1 — the mark outlives the VIEW. A workspace switch untracks the
// tracker and detaches the PTY view, but the pane and its input box — with
// the owner's half-typed bytes — survive. The r8 tracked.has short-circuit
// read "no attached view" as "no composer" and made exactly the detached
// agents that background dispatch targets dispatchable over live owner text.
// ---------------------------------------------------------------------------

describe('ownerComposing survives detach (Sol r9 P0-1)', () => {
  it('type → detach: the composer answer stands, dispatch stays refused', () => {
    const { tracker, session } = guardFixture()
    session.emit('input', 'half a brief for the release')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    tracker.untrack('term-1')
    // The view is gone; the dirty box is not.
    expect(tracker.ownerComposing('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('detach → reattach → submit: only the observed submit readmits', () => {
    const { tracker, session } = guardFixture()
    session.emit('input', 'half a brief')
    tracker.untrack('term-1')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    tracker.track(session as unknown as PtySession, true)
    // Still composing: reattaching proves nothing about the box.
    expect(tracker.ownerComposing('term-1')).toBe(true)
    // Ctrl-U after reattach cannot prove it either — the fresh model never
    // watched the detached bytes, and a kill-line clears at most ONE line
    // of a box whose shape it does not know.
    session.emit('input', '\x15')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    // The positively observed submit consumes the box wholesale.
    session.emit('input', 'ship the release\r')
    expect(tracker.ownerComposing('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('retirement clears a detached mark — the box died with the process', () => {
    const { tracker, lease, session } = guardFixture()
    session.emit('input', 'doomed typing')
    tracker.untrack('term-1')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    lease.retire('term-1')
    expect(tracker.ownerComposing('term-1')).toBe(false)
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r9 P0-2 — ownership is ANY byte, release is PROOF. `.trim()` declared
// whitespace-only boxes clean, and the prompt model maps every Ctrl-U/Ctrl-C
// to an empty buffer even though those ops prove at most one line cleared —
// both readmitted dispatches over real owner bytes still in the TUI.
// ---------------------------------------------------------------------------

describe('owner-editing proof rules (Sol r9 P0-2)', () => {
  it('whitespace-only typing marks — a space is a real byte in the real box', () => {
    const { tracker, session } = guardFixture()
    session.emit('input', '   ')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('Shift+Enter multiline then Ctrl-U keeps the mark — one line of proof is not the box', () => {
    const { tracker, session } = guardFixture()
    session.emit('input', 'line one')
    session.emit('input', '\x1b\r') // Shift+Enter: the TUI insert-newline binding
    session.emit('input', 'line two')
    session.emit('input', '\x15')
    // The model shows empty, but Ctrl-U provably cleared ONE line; the mark
    // holds — and keeps holding, because the model has diverged from the box.
    expect(tracker.ownerComposing('term-1')).toBe(true)
    session.emit('input', '\x15')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    // The observed submit is what clears it.
    session.emit('input', '\r')
    expect(tracker.ownerComposing('term-1')).toBe(false)
    tracker.disposeAll()
  })

  it('Ctrl-C never clears — it doubles as interrupt/quit per harness', () => {
    const { tracker, session } = guardFixture()
    session.emit('input', 'half a thought')
    session.emit('input', '\x03')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    // And having fired over a non-empty box, it poisons content provenance:
    // even a later single-line Ctrl-U is no longer proof until a submit.
    session.emit('input', 'x')
    session.emit('input', '\x15')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('split paste markers keep the mark — bytes are in flight toward the box', () => {
    const { tracker, session } = guardFixture()
    // A partial marker withheld across chunks is still buffered input state.
    session.emit('input', '\x1b[20')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    // The completed open marker starts a paste: still the owner's box.
    session.emit('input', '0~pasted text')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    // Closed paste: the content sits unsubmitted in the box.
    session.emit('input', '\x1b[201~')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    tracker.disposeAll()
  })

  it('a pasted multiline body is opaque to Ctrl-U exactly like Shift+Enter', () => {
    const { tracker, session } = guardFixture()
    session.emit('input', '\x1b[200~two\nlines\x1b[201~')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    session.emit('input', '\x15')
    expect(tracker.ownerComposing('term-1')).toBe(true)
    session.emit('input', 'go\r')
    expect(tracker.ownerComposing('term-1')).toBe(false)
    tracker.disposeAll()
  })
})

describe('TurnTracker.refusalReason (Sol r8 P1)', () => {
  it('names the holder, the contamination, or nothing', () => {
    const { tracker, lease } = guardFixture()
    expect(tracker.refusalReason('term-1')).toBeNull()
    const dispatch = dispatchHolder('dsp-1')
    lease.acquire('term-1', dispatch)
    expect(tracker.refusalReason('term-1')).toContain('dispatch is being delivered')
    lease.release('term-1', dispatch)
    const owner = ownerHolder()
    lease.acquire('term-1', owner)
    expect(tracker.refusalReason('term-1')).toContain('owner submission is in flight')
    lease.release('term-1', owner)
    lease.markContaminated('term-1')
    expect(tracker.refusalReason('term-1')).toContain('restart the terminal')
    tracker.disposeAll()
  })
})

// ---------------------------------------------------------------------------
// Sol r8 P2 — retirement reclaims state. `retire` used to hide the dead hold
// behind a generation mismatch and keep both map entries for the process
// lifetime; removed UUIDs never return, so create/retire cycles grew the
// singleton monotonically.
// ---------------------------------------------------------------------------

describe('ProducerLease — retirement reclaims map state (Sol r8 P2)', () => {
  it('retire DELETES the holds entry, not merely hides it', () => {
    const lease = new ProducerLease()
    lease.acquire('term-1', dispatchHolder('dsp-old'))
    expect(lease.mapSizes().holds).toBe(1)
    lease.retire('term-1')
    expect(lease.mapSizes().holds).toBe(0)
  })

  it('create/retire cycles stay bounded across every map', () => {
    const lease = new ProducerLease()
    for (let i = 0; i < 3000; i += 1) {
      const id = `term-${i}`
      lease.acquire(id, dispatchHolder(`dsp-${i}`))
      lease.markContaminated(id)
      lease.markOwnerEditing(id)
      lease.retire(id)
    }
    const sizes = lease.mapSizes()
    expect(sizes.holds).toBe(0)
    expect(sizes.contaminated).toBe(0)
    expect(sizes.ownerEditing).toBe(0)
    // Generation tombstones are bounded, not eternal: kept only while a
    // stale asynchronous holder could still return.
    expect(sizes.generations).toBeLessThanOrEqual(1024)
  })

  it('the bound never reclaims a generation protecting a LIVE hold or mark', () => {
    const lease = new ProducerLease()
    // A rebound terminal: retired once, then re-acquired in its new life.
    lease.retire('term-live')
    const generation = lease.generationOf('term-live')
    lease.acquire('term-live', dispatchHolder('dsp-live'))
    lease.markContaminated('term-mark')
    lease.retire('term-mark')
    lease.markContaminated('term-mark')
    for (let i = 0; i < 2000; i += 1) lease.retire(`churn-${i}`)
    // The churn evicted dead tombstones, never the live ones.
    expect(lease.generationOf('term-live')).toBe(generation)
    expect(lease.holderOf('term-live')).toEqual(dispatchHolder('dsp-live'))
    expect(lease.isContaminated('term-mark')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Sol r9 P1-8 — liveness is REPRESENTED, not inferred from holds/marks. A CWD
// rebind retires and immediately respawns the same terminal id; while the
// reborn generation sat idle it carried no hold or mark, so the tombstone
// bound could evict it — generationOf fell back to 0, current-generation asks
// read as retired, and an ancient generation-0 leg passed the checks again.
// The conductor wires registerTerminal at spawn and forgetTerminal at node
// removal.
// ---------------------------------------------------------------------------

describe('ProducerLease — liveness pins generations (Sol r9 P1-8)', () => {
  it('an idle rebound terminal (retire + register, same id) survives 2000 later retires', () => {
    const lease = new ProducerLease()
    lease.registerTerminal('term-rebind')
    // The CWD rebind: permanent ending of the old pane, immediate respawn
    // under the SAME id — no hold, no mark, just a live idle terminal.
    lease.retire('term-rebind')
    lease.registerTerminal('term-rebind')
    const generation = lease.generationOf('term-rebind')
    expect(generation).toBe(1)
    for (let i = 0; i < 2000; i += 1) lease.retire(`churn-${i}`)
    // Still generation 1: current-generation asks keep passing, and a stale
    // generation-0 leg keeps failing.
    expect(lease.generationOf('term-rebind')).toBe(generation)
    expect(lease.acquire('term-rebind', ownerHolder(), { generation })).toBe('acquired')
  })

  it('a FORGOTTEN id evicts once its bounded tombstone window drains', () => {
    const lease = new ProducerLease()
    lease.registerTerminal('term-gone')
    lease.retire('term-gone')
    // Permanent removal: the liveness pin lifts, the entry becomes an
    // ordinary tombstone and the churn bound reclaims it in its turn.
    lease.forgetTerminal('term-gone')
    for (let i = 0; i < 2000; i += 1) lease.retire(`churn-${i}`)
    expect(lease.generationOf('term-gone')).toBe(0)
    expect(lease.mapSizes().generations).toBeLessThanOrEqual(1024)
  })

  it('registration alone never grows the generation map — only retires mint entries', () => {
    const lease = new ProducerLease()
    for (let i = 0; i < 50; i += 1) lease.registerTerminal(`spawn-${i}`)
    expect(lease.mapSizes().generations).toBe(0)
    expect(lease.mapSizes().live).toBe(50)
    for (let i = 0; i < 50; i += 1) lease.forgetTerminal(`spawn-${i}`)
    expect(lease.mapSizes().live).toBe(0)
  })
})

describe('ProducerLease — retirement observers (Sol r8 P1)', () => {
  it('notifies with the retired id, after the retire landed; unsubscribe stops it', () => {
    const lease = new ProducerLease()
    const seen: Array<{ id: string; holds: number }> = []
    const unsubscribe = lease.onRetire((id) =>
      seen.push({ id, holds: lease.mapSizes().holds })
    )
    lease.acquire('term-1', dispatchHolder('dsp-1'))
    lease.retire('term-1')
    // The listener observed the retired world — the hold already reclaimed.
    expect(seen).toEqual([{ id: 'term-1', holds: 0 }])
    unsubscribe()
    lease.retire('term-2')
    expect(seen).toHaveLength(1)
  })
})
