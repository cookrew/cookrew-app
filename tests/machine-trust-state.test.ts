import { describe, expect, it, vi } from 'vitest'
import { createMachineTrust, type MachineTrustDeps } from '../src/main/machine-trust-state'

/**
 * DOES THE ACCOUNT TRUST THIS MACHINE (main/machine-trust-state.ts). The
 * registry decides, at the sign-in: a password, a passkey or the authenticator
 * made on this machine, and it is trusted from then. This machine used to learn
 * the answer only as a side effect of collecting a key for ANOTHER machine, so
 * with no other machine online it never asked, took "not asked" for "no", and
 * told a Mac signed in three minutes ago to sign in again (owner, 2026-11-11).
 * Not asked is not known, and nothing is said about it.
 */

function bed(start: { marker?: boolean; who?: string | null } = {}) {
  const world = { marker: start.marker ?? false, who: start.who === undefined ? 'anvztor|1' : start.who, answer: { status: 201 } as { status: number; error?: string } | null, clock: 1_000_000 }
  const ask = vi.fn(async () => world.answer)
  const deps: MachineTrustDeps = {
    marker: { exists: () => world.marker, write: () => void (world.marker = true), remove: () => void (world.marker = false) },
    ask,
    who: () => world.who,
    now: () => world.clock
  }
  return { world, ask, trust: createMachineTrust(deps) }
}

describe('what this machine knows about its own standing', () => {
  it('knows nothing until the registry has been asked, and says so', () => {
    const { trust, ask } = bed()
    expect(trust.state()).toBe('unknown')
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks once for a sign-in, with nobody else online to ask for: trusted is written down', async () => {
    const { trust, ask, world } = bed()
    expect(await trust.learn()).toBe('trusted')
    expect(world.marker).toBe(true)
    await trust.learn()
    await trust.learn()
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('needs its proof only when the registry said exactly that, about this sign-in', async () => {
    const { trust, world } = bed()
    world.answer = { status: 401, error: 'proof_required' }
    expect(await trust.learn()).toBe('needs-proof')
    expect(world.marker).toBe(false)
    // Another sign-in on this machine is another question: not known again until asked.
    world.who = 'anvztor|2'
    expect(trust.state()).toBe('unknown')
    world.answer = { status: 201 }
    expect(await trust.learn()).toBe('trusted')
  })

  it('an answer that is neither (offline, resting, a server error) leaves it unknown, and is asked again later, not at once', async () => {
    const { trust, ask, world } = bed()
    for (const answer of [null, { status: 429, error: 'rate_limited' }, { status: 500 }, { status: 401, error: 'unauthenticated' }]) {
      world.answer = answer
      world.clock += 120_000
      expect(await trust.learn()).toBe('unknown')
    }
    const asked = ask.mock.calls.length
    await trust.learn()
    expect(ask).toHaveBeenCalledTimes(asked)
    world.clock += 120_000
    world.answer = { status: 201 }
    expect(await trust.learn()).toBe('trusted')
  })

  it('a marker left by the last person is checked for the next one, and taken down when the registry says no', async () => {
    const { trust, world, ask } = bed({ marker: true })
    world.answer = { status: 401, error: 'proof_required' }
    expect(await trust.learn()).toBe('needs-proof')
    expect(world.marker).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('signed out, it knows nothing and asks nobody', async () => {
    const { trust, ask } = bed({ who: null, marker: true })
    expect(await trust.learn()).toBe('unknown')
    expect(ask).not.toHaveBeenCalled()
  })

  it('takes what the key round heard too: a grant, or a demand for proof', () => {
    const { trust, world } = bed()
    trust.heard(401, 'proof_required')
    expect(trust.state()).toBe('needs-proof')
    trust.heard(201)
    expect(trust.state()).toBe('trusted')
    expect(world.marker).toBe(true)
    trust.heard(500)
    expect(trust.state()).toBe('trusted')
  })

  it('two askers at once are one question', async () => {
    const { trust, ask } = bed()
    await Promise.all([trust.learn(), trust.learn(), trust.learn()])
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('after the proof was given, it asks at once, whatever it asked a moment ago', async () => {
    const { trust, ask, world } = bed()
    world.answer = { status: 401, error: 'proof_required' }
    await trust.learn()
    world.answer = { status: 201 }
    expect(await trust.learn({ now: true })).toBe('trusted')
    expect(ask).toHaveBeenCalledTimes(2)
  })
})
