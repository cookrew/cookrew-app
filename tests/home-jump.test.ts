// THE PAGE GOES HOME BY ITSELF — exactly when a knock the browser carried got in.
import { describe, expect, it } from 'vitest'
import { HOME_JUMP_COOLDOWN_MS, homeJump } from '../src/renderer/src/path/home-jump'
import type { DirectOffer } from '../src/renderer/src/path/direct-offer'
import type { ReachProbe } from '../src/renderer/src/path/reach-probes'

const LAN = 'https://192-168-2-40.e03994f9-138d-80ff-9377-475cc59142b4.d.cookrew.dev:8643'
const NAME = '192-168-2-40.e03994f9-138d-80ff-9377-475cc59142b4.d.cookrew.dev:8643'
const offer: DirectOffer = { origin: LAN, kind: 'lan', family: 'Safari', reason: 'timeout' }
const probe = (kind: ReachProbe['kind'], outcome: ReachProbe['outcome'], name = NAME): ReachProbe => ({
  kind,
  name,
  outcome,
  ms: 40
})
const NOW = 1_800_000_000_000

describe('homeJump', () => {
  it('jumps to the offered name when any knock on THAT name answered', () => {
    expect(homeJump({ offer, probes: [probe('socket', 'answered')], lastJumpAt: null, now: NOW })).toBe(LAN)
    expect(homeJump({ offer, probes: [probe('socket', 'timeout'), probe('image', 'answered')], lastJumpAt: null, now: NOW })).toBe(LAN)
    expect(homeJump({ offer, probes: [probe('opaque', 'answered')], lastJumpAt: null, now: NOW })).toBe(LAN)
  })

  it('never without an answer — a timeout is a Mac that is not here, and a jump would be a dead page', () => {
    expect(homeJump({ offer, probes: [probe('socket', 'timeout'), probe('image', 'network'), probe('opaque', 'timeout')], lastJumpAt: null, now: NOW })).toBeNull()
    expect(homeJump({ offer, probes: [], lastJumpAt: null, now: NOW })).toBeNull()
  })

  it('never on an answer about some OTHER name', () => {
    expect(homeJump({ offer, probes: [probe('socket', 'answered', 'other.example:8643')], lastJumpAt: null, now: NOW })).toBeNull()
  })

  it('never without an offer, and never for the proxy case, which has a desktop answer', () => {
    expect(homeJump({ offer: null, probes: [probe('socket', 'answered')], lastJumpAt: null, now: NOW })).toBeNull()
    expect(homeJump({ offer: { ...offer, reason: 'proxy' }, probes: [probe('socket', 'answered')], lastJumpAt: null, now: NOW })).toBeNull()
  })

  it('not twice within the cooldown — a landing that bounced must not loop', () => {
    const probes = [probe('socket', 'answered')]
    expect(homeJump({ offer, probes, lastJumpAt: NOW - HOME_JUMP_COOLDOWN_MS + 1, now: NOW })).toBeNull()
    expect(homeJump({ offer, probes, lastJumpAt: NOW - HOME_JUMP_COOLDOWN_MS, now: NOW })).toBe(LAN)
  })
})
