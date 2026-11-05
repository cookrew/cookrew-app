// `cookrew dispatch` on a turn the owner stopped said "unverifiable: the brief
// may be running; do NOT resend blind" (Menu QA, 2026-11-04), though the ledger
// knew the turn and that it was over. It says what the record says now. The
// exit stays non-zero: an ended dispatch that did not complete is no success.
import { describe, expect, it } from 'vitest'
import { DeliveryError, dispatchEndError } from '../src/main/ask-delivery'
import { ASK_EXIT, ASK_REMEDY } from '../src/shared/ask-outcome'

describe('a dispatch that ended without completing', () => {
  it('a turn the transcript saw stopped: over, named, and no warning that it may be running', () => {
    const error = dispatchEndError({ state: 'interrupted', agentName: 'MQ Cold', turnIndex: 72, error: 'interrupted: the agent turn was interrupted' }, 'id')
    expect(error.message).toContain('MQ Cold: interrupted · turn 72')
    expect(error.message).toContain('the turn is over')
    expect(error.message).not.toContain('may be running')
    expect(error.message).not.toContain('unverifiable')
  })
  it('an agent that errored names its turn and its error', () => {
    const error = dispatchEndError({ state: 'failed', agentName: 'A', turnIndex: 3, error: 'agent aborted/errored' }, 'id')
    expect(error.message).toContain('A: failed · turn 3 · agent aborted/errored')
    expect(error.message).toContain('the turn is over')
  })
  it('no turn behind it: nobody saw the end, so the caution stands, with the real reason', () => {
    const error = dispatchEndError({ state: 'interrupted', agentName: 'A', error: 'interrupted: no outcome within 10 minutes' }, 'id')
    expect(error.message).toContain('no outcome within 10 minutes')
    expect(error.message).toContain(ASK_REMEDY.unverifiable)
  })
  it('falls back to the id for a record with no name', () => {
    expect(dispatchEndError({ state: 'failed' }, 'abc').message).toContain('abc: failed')
  })
  it('leaves as it always did: a shell caller reads the same code', () => {
    for (const record of [{ state: 'interrupted', turnIndex: 1 }, { state: 'failed' }]) {
      const error = dispatchEndError(record, 'id')
      expect(error).toBeInstanceOf(DeliveryError)
      expect(error.exitCode).toBe(ASK_EXIT.unverifiable)
    }
  })
})
