// WHICH GATE MAGPIE REMOTE ASKS (seat-gate.ts): on macOS, lane Seatbelt's servedSeatGate (every served
// seat runs today's profile, no leftovers); elsewhere there is no Seatbelt profile to vouch for a served
// terminal, so the forwarder stays shut while any is on the canvas. Anything that throws is shut.
import { describe, expect, it, vi } from 'vitest'
import { magpieSeatGate } from '../src/main/magpie-remote/seat-gate'

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
