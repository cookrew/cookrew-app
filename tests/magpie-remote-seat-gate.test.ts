// WHICH GATE MAGPIE REMOTE ASKS (seat-gate.ts): on macOS, lane Seatbelt's servedSeatGate (every served
// seat runs today's profile, no leftovers); elsewhere there is no Seatbelt profile to vouch for a served
// terminal, so the forwarder stays shut while any is on the canvas. Anything that throws is shut.
import { describe, expect, it, vi } from 'vitest'
import { magpieSeatGate, trackServedSeat } from '../src/main/magpie-remote/seat-gate'

const open = { open: true, why: null }
const shut = { open: false, why: '1 served session(s) run under an older sandbox: restart them first.' }

describe('the served-seat gate Magpie remote asks', () => {
  it('on macOS asks Seatbelt’s gate, whatever is on the canvas', async () => {
    const served = vi.fn(async () => open)
    expect(await magpieSeatGate({ platform: 'darwin', servedSeatGate: served, servedOnCanvas: () => true })()).toBe(true)
    expect(await magpieSeatGate({ platform: 'darwin', servedSeatGate: async () => shut, servedOnCanvas: () => false })()).toBe(false)
    expect(served).toHaveBeenCalledTimes(1)
  })

  it('on macOS is shut when Seatbelt’s gate throws', async () => {
    const gate = magpieSeatGate({ platform: 'darwin', servedSeatGate: async () => { throw new Error('lsof died') }, servedOnCanvas: () => false })
    expect(await gate()).toBe(false)
  })

  it.each(['linux', 'win32'] as const)('on %s is shut while any served terminal is on the canvas, and never asks Seatbelt', async (platform) => {
    const served = vi.fn(async () => open)
    expect(await magpieSeatGate({ platform, servedSeatGate: served, servedOnCanvas: () => true })()).toBe(false)
    expect(await magpieSeatGate({ platform, servedSeatGate: served, servedOnCanvas: () => false })()).toBe(true)
    expect(served).not.toHaveBeenCalled()
  })

  it('is shut when the canvas cannot be read', async () => {
    const gate = magpieSeatGate({ platform: 'linux', servedSeatGate: async () => open, servedOnCanvas: () => { throw new Error('store') } })
    expect(await gate()).toBe(false)
  })
})

describe('relay acceptance 3: every served start and end drops Magpie remote’s cached gate answer', () => {
  const hooks = () => {
    const calls: string[] = []
    let exit: (() => void) | null = null
    return {
      calls,
      exit: () => exit?.(),
      record: (seat: string) => void calls.push(`record:${seat}`),
      forget: (seat: string) => void calls.push(`forget:${seat}`),
      seatsChanged: () => void calls.push('seatsChanged'),
      onExit: (run: () => void) => void (exit = run)
    }
  }

  it('a fresh seat: recorded, then the cache dropped; on exit forgotten, then the cache dropped', () => {
    const h = hooks()
    trackServedSeat('seat-1', h)
    expect(h.calls).toEqual(['record:seat-1', 'seatsChanged'])
    h.exit()
    expect(h.calls).toEqual(['record:seat-1', 'seatsChanged', 'forget:seat-1', 'seatsChanged'])
  })

  it('a reattached session (no ledger record): the cache is dropped on start and on exit all the same', () => {
    const h = hooks()
    trackServedSeat(null, h)
    expect(h.calls).toEqual(['seatsChanged'])
    h.exit()
    expect(h.calls).toEqual(['seatsChanged', 'seatsChanged'])
  })
})
