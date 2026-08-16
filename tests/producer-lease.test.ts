// Sol r6 P0-1 — the one-producer LEASE, not a point-in-time check.
//
// The r5 guard preempted an armed dispatch at the moment of an owner submit,
// but reserved nothing: a dispatch could arm and submit while an owner ask
// was inside its blocking promptAgent, two owner asks could both pass, and
// owner typing could enter a buffer holding a dispatch's half-ingested paste.
// The lease is the missing reservation. This file pins the acquisition
// matrix (owner/dispatch × free/held/displaced/reentrant) and the tracker
// guard's mid-delivery byte refusal.

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
    // Not even with the takeover flag: displacement is owner-over-dispatch
    // after a committed preemption, never the reverse.
    expect(lease.acquire('term-1', dispatchHolder('dsp-1'), { displaceDispatch: true })).toBe(
      'held-by-owner'
    )
    expect(lease.holderOf('term-1')).toBe(owner)
  })

  it('owner vs dispatch-held: named refusal, then takeover after a committed preemption', () => {
    const lease = new ProducerLease()
    const dispatch = dispatchHolder('dsp-1')
    lease.acquire('term-1', dispatch)
    const owner = ownerHolder()
    // The plain acquire names WHO holds it, so the caller can run the
    // durable preemption rather than guess.
    expect(lease.acquire('term-1', owner)).toBe('held-by-dispatch')
    // Committed preemption → displacement.
    expect(lease.acquire('term-1', owner, { displaceDispatch: true })).toBe('acquired')
    expect(lease.holderOf('term-1')).toBe(owner)
    // The displaced leg's finally-release is a holder-mismatch NO-OP: the
    // takeover cannot be undone by the loser unwinding out of promptAgent.
    lease.release('term-1', dispatch)
    expect(lease.holderOf('term-1')).toBe(owner)
  })

  it('owner vs owner-held: refused honestly — nothing preempts an owner submission', () => {
    const lease = new ProducerLease()
    const first = ownerHolder()
    lease.acquire('term-1', first)
    const second = ownerHolder()
    expect(lease.acquire('term-1', second)).toBe('held-by-owner')
    // displaceDispatch displaces DISPATCH holders only.
    expect(lease.acquire('term-1', second, { displaceDispatch: true })).toBe('held-by-owner')
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
// The tracker guard's lease half: while a dispatch DELIVERY holds the lease,
// non-preempting owner bytes are refused at the PTY guard — they must not
// enter a buffer containing a partial dispatch delivery. A SUBMITTING owner
// write still routes to the durable preemption (owner takeover).
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

function guardFixture(): { tracker: TurnTracker; lease: ProducerLease } {
  const lease = new ProducerLease()
  const tracker = new TurnTracker(async () => null, null, lease)
  const session = new FakeSession()
  tracker.track(session as unknown as PtySession, true)
  return { tracker, lease }
}

describe('guardOwnerInput during a dispatch delivery (lease held)', () => {
  it('refuses NON-SUBMIT owner bytes while the delivery holds the lease', () => {
    const { tracker, lease } = guardFixture()
    tracker.noteDispatch('term-1', 'dsp-1', 'the brief')
    lease.acquire('term-1', dispatchHolder('dsp-1'))
    // Typing, a paste without Enter, a bare Enter: all would land in (or
    // submit) the buffer the delivery is mid-pasting into.
    expect(tracker.guardOwnerInput('term-1', 'owner typing')).toBe('refused')
    expect(tracker.guardOwnerInput('term-1', '\r')).toBe('refused')
    tracker.disposeAll()
  })

  it('a SUBMITTING owner write still takes over via the durable preemption', () => {
    const { tracker, lease } = guardFixture()
    tracker.noteDispatch('term-1', 'dsp-1', 'the brief')
    lease.acquire('term-1', dispatchHolder('dsp-1'))
    const preempted: string[] = []
    tracker.onOwnerPreempt = (terminalId) => {
      preempted.push(terminalId)
      return true // the interrupt row committed durably
    }
    expect(tracker.guardOwnerInput('term-1', 'an owner ask\r')).toBe('allow')
    expect(preempted).toEqual(['term-1'])
    tracker.disposeAll()
  })

  it('an uncommitted preemption still refuses the submit (fail-closed)', () => {
    const { tracker, lease } = guardFixture()
    tracker.noteDispatch('term-1', 'dsp-1', 'the brief')
    lease.acquire('term-1', dispatchHolder('dsp-1'))
    tracker.onOwnerPreempt = () => false
    expect(tracker.guardOwnerInput('term-1', 'an owner ask\r')).toBe('preempt-failed')
    tracker.disposeAll()
  })

  it('a lease held with NO armed stamp left is a leg still unwinding — refuse', () => {
    const { tracker, lease } = guardFixture()
    lease.acquire('term-1', dispatchHolder('dsp-1'))
    expect(tracker.guardOwnerInput('term-1', 'an owner ask\r')).toBe('refused')
    tracker.disposeAll()
  })

  it('an UNTRACKED terminal under a delivering lease refuses too', () => {
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

  it('an owner-held lease (an ask mid-paste) does not trip the dispatch refusal', () => {
    const { tracker, lease } = guardFixture()
    lease.acquire('term-1', ownerHolder())
    // The typed ask's own paste bytes cross this guard while it holds the
    // lease as owner — they must pass, or the ask would refuse itself.
    expect(tracker.guardOwnerInput('term-1', 'the ask body')).toBe('allow')
    tracker.disposeAll()
  })
})
