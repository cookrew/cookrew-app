// Solis, 2026-11-09: a recruit's brief was delivered, claude exited 1 before any
// transcript witnessed it, and every later `cookrew ask` was refused with "input
// box holds an unconfirmed dispatch delivery — awaiting the transcript witness (or
// restart the terminal)". The pane was gone, so was its input box, and the CLI has
// no restart. A pane the multiplexer positively says is gone takes its box facts
// with it, the way a proven kill does.
import { describe, expect, it, vi } from 'vitest'
import { ProducerLease } from '../src/main/producer-lease'
import { forgetDeadBox } from '../src/main/dead-box'

function residue(): ProducerLease {
  const lease = new ProducerLease()
  lease.noteDispatchBytesEntering('t1', 'fix the login redirect')
  expect(lease.hasDispatchResidue('t1')).toBe(true)
  return lease
}

describe('forgetDeadBox', () => {
  it('clears an unconfirmed delivery when the pane is positively gone', () => {
    const lease = residue()
    expect(forgetDeadBox(lease, 't1', () => false)).toBe(true)
    expect(lease.hasDispatchResidue('t1')).toBe(false)
    expect(lease.isContaminated('t1')).toBe(false)
    // The ask that was refused before can take the box now.
    expect(lease.acquire('t1', { kind: 'owner', askId: 'a1' })).toBe('acquired')
  })

  it('clears a stranded paste too: the box it sat in is gone', () => {
    const lease = new ProducerLease()
    lease.markContaminated('t1')
    expect(forgetDeadBox(lease, 't1', () => false)).toBe(true)
    expect(lease.isContaminated('t1')).toBe(false)
  })

  it('keeps every fact when the pane is there, or nobody can say', () => {
    for (const presence of [true, null]) {
      const lease = residue()
      expect(forgetDeadBox(lease, 't1', () => presence)).toBe(false)
      expect(lease.hasDispatchResidue('t1')).toBe(true)
    }
  })

  it('asks the multiplexer nothing for a clean box', () => {
    const presence = vi.fn(() => false)
    expect(forgetDeadBox(new ProducerLease(), 't1', presence)).toBe(false)
    expect(presence).not.toHaveBeenCalled()
  })
})
