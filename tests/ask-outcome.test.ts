import { describe, expect, it } from 'vitest'
import {
  ASK_EXIT,
  ASK_REMEDY,
  classifyDelivery,
  isDelivered,
  type AskOutcome,
  type DeliveryEvidence
} from '../src/shared/ask-outcome'

// The delivery contract, pinned where it is pure.
//
// Owner-reproduced defect, five agents in one session: `cookrew ask` pasted a
// brief that never submitted and exited 0 with empty output — the same answer
// it gives for a brief that vanished, and the same answer it gives for one
// that worked and said nothing. Three different worlds, one exit code.
//
// These tests are about the two that must never merge and the one that must
// never be spent as success.

const evidence = (over: Partial<DeliveryEvidence> = {}): DeliveryEvidence => ({
  turnStarted: false,
  observable: true,
  promptInBox: null,
  ...over
})

describe('classifyDelivery — a started turn ends the question', () => {
  it('reports the brief running when the tracker saw the turn begin', () => {
    expect(classifyDelivery(evidence({ turnStarted: true }))).toBe('completed')
  })

  it('trusts a started turn even where the box cannot be read', () => {
    // The turn IS the proof. Once an agent is working, what the input box
    // looks like is a question about echo, not about delivery.
    expect(
      classifyDelivery(evidence({ turnStarted: true, observable: false, promptInBox: null }))
    ).toBe('completed')
  })
})

describe('classifyDelivery — the two remedies that must never merge', () => {
  it('calls a brief sitting in the box UNSUBMITTED, not dropped', () => {
    // `[Pasted text #N +M lines]`, no turn. The fix is one carriage return.
    expect(classifyDelivery(evidence({ promptInBox: true }))).toBe('unsubmitted')
  })

  it('calls an empty box DROPPED, not unsubmitted', () => {
    expect(classifyDelivery(evidence({ promptInBox: false }))).toBe('dropped')
  })

  it('gives opposite remedies, because applying either to the other corrupts', () => {
    // Resending text into a box that already holds it pastes a second copy.
    // Sending a bare CR to an empty box submits whatever was already there.
    expect(ASK_REMEDY.unsubmitted).toMatch(/do NOT resend/i)
    expect(ASK_REMEDY.dropped).toMatch(/again/i)
    expect(ASK_REMEDY.unsubmitted).not.toBe(ASK_REMEDY.dropped)
    expect(ASK_EXIT.unsubmitted).not.toBe(ASK_EXIT.dropped)
  })
})

describe('classifyDelivery — a fact about US is not a fact about THEM', () => {
  // The category, met twice: an unreachable facilitator reported as `invalid`
  // accused a buyer who had paid; an unobservable terminal reported as
  // `dropped` accuses an agent that may be working perfectly.

  it('an UNOBSERVABLE terminal is unverifiable — never dropped', () => {
    // A detached pane, an untracked terminal, a dormant workspace's agent.
    // None of these is evidence that anything failed.
    expect(classifyDelivery(evidence({ observable: false }))).toBe('unverifiable')
  })

  it('stays unverifiable even when the box READS empty but we cannot see', () => {
    // The trap: a capture that returns nothing because there is no view is
    // indistinguishable, byte for byte, from a genuinely empty box. Only the
    // observability fact separates them, so it is checked FIRST.
    expect(
      classifyDelivery(evidence({ observable: false, promptInBox: false }))
    ).toBe('unverifiable')
  })

  it('an unanswerable box question is unverifiable, not dropped', () => {
    expect(classifyDelivery(evidence({ observable: true, promptInBox: null }))).toBe('unverifiable')
  })

  it('never lets "I could not confirm" be spendable as success', () => {
    // The ruling. A zero here would put unverifiable back inside the defect it
    // was created to escape.
    expect(ASK_EXIT.unverifiable).not.toBe(0)
    expect(isDelivered('unverifiable')).toBe(false)
  })
})

describe('classifyDelivery — a refusal is the pane telling us, not us guessing', () => {
  it('reports busy and unreachable as themselves', () => {
    expect(classifyDelivery(evidence({ refused: 'busy' }))).toBe('busy')
    expect(classifyDelivery(evidence({ refused: 'unreachable' }))).toBe('unreachable')
  })

  it('a refusal outranks everything — nothing was delivered to be in a box', () => {
    expect(
      classifyDelivery(evidence({ refused: 'busy', promptInBox: true, observable: true }))
    ).toBe('busy')
  })

  it('is never confused with a delivery failure: distinct codes, distinct remedies', () => {
    for (const outcome of ['busy', 'unreachable'] as const) {
      expect(ASK_EXIT[outcome]).not.toBe(ASK_EXIT.dropped)
      expect(ASK_EXIT[outcome]).not.toBe(ASK_EXIT.unsubmitted)
    }
  })
})

describe('the exit-code table itself', () => {
  const outcomes: AskOutcome[] = [
    'completed',
    'started',
    'unsubmitted',
    'dropped',
    'busy',
    'unreachable',
    'unverifiable'
  ]

  it('gives 0 to exactly the two outcomes where the agent got the work', () => {
    const zero = outcomes.filter((o) => ASK_EXIT[o] === 0)
    expect(zero.sort()).toEqual(['completed', 'started'])
  })

  it('gives every failure its OWN code — no shared 1 to be ambiguous with', () => {
    const failures = outcomes.filter((o) => ASK_EXIT[o] !== 0).map((o) => ASK_EXIT[o])
    expect(new Set(failures).size).toBe(failures.length)
  })

  it('carries a remedy for every outcome, so no caller has to guess', () => {
    for (const outcome of outcomes) {
      expect(ASK_REMEDY[outcome].length).toBeGreaterThan(0)
    }
  })

  it('agrees with isDelivered on every outcome', () => {
    for (const outcome of outcomes) {
      expect(isDelivered(outcome)).toBe(ASK_EXIT[outcome] === 0)
    }
  })
})
