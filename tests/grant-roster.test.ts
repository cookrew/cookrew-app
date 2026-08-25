import { describe, expect, it } from 'vitest'
import { buildGrantRoster, keyFingerprint } from '../src/main/grant-roster'
import type { CallIdentity } from '../src/main/call-inflight'
import type { AgentExport, EnrolledCaller } from '../src/main/agent-export'

/**
 * WHAT THE OWNER CAN SEE ABOUT WHAT THEY GRANTED.
 *
 * The grant surface could already CHANGE things and could barely SHOW them —
 * `grant:list` handed back raw exports, which is the record's shape rather than
 * the question's. The question an owner actually has is "who can reach my
 * agents, and what is happening right now", and the revoke ruling makes the
 * second half load-bearing: a control whose copy promises to stop calls already
 * running is unusable if the surface cannot say whether any are.
 *
 * This assembles the answer and decides nothing. Every refusal still lives in
 * the gate; nothing here is consulted by it.
 */

const JWK = { kty: 'OKP', crv: 'Ed25519', x: 'abc123' }
const OTHER_JWK = { kty: 'OKP', crv: 'Ed25519', x: 'zzz999' }

const enrolled = (over: Partial<EnrolledCaller> = {}): EnrolledCaller => ({
  workspaceId: 'w1',
  sub: 'buyer-1',
  jwk: JWK,
  ...over
})

const exported = (over: Partial<AgentExport> = {}): AgentExport => ({
  workspaceId: 'w1',
  nodeId: 'node-1',
  visibility: 'identified',
  callers: ['buyer-1'],
  ...over
})

function roster(input: {
  callers?: EnrolledCaller[]
  exports?: AgentExport[]
  live?: CallIdentity[]
}) {
  return buildGrantRoster({
    workspaceId: 'w1',
    enrolledIn: () => input.callers ?? [],
    exportsIn: () => input.exports ?? [],
    callsIn: () => input.live ?? []
  })
}

describe('the roster answers who can reach what', () => {
  it('is empty, and says so in a shape the surface can render', () => {
    expect(roster({})).toEqual({
      workspaceId: 'w1', callers: [], agents: [], revoked: [], live: []
    })
  })

  it('names each caller and the agents it may call', () => {
    const r = roster({
      callers: [enrolled(), enrolled({ sub: 'buyer-2' })],
      exports: [exported({ nodeId: 'node-1', callers: ['buyer-1', 'buyer-2'] }),
        exported({ nodeId: 'node-2', callers: ['buyer-2'] })]
    })
    expect(r.callers.map((c) => ({ sub: c.sub, agents: c.agents }))).toEqual([
      { sub: 'buyer-1', agents: ['node-1'] },
      { sub: 'buyer-2', agents: ['node-1', 'node-2'] }
    ])
  })

  it('shows an ENROLLED caller who can call nothing — a half-made grant', () => {
    // The state an owner most often lands in by mistake: enrolled, exported
    // nowhere. Rendering it as "no agents" rather than hiding it is what makes
    // the mistake visible instead of a call that mysteriously 403s.
    const r = roster({ callers: [enrolled()] })
    expect(r.callers).toEqual([
      {
        sub: 'buyer-1',
        keyFingerprint: keyFingerprint(JWK),
        // Not an ed25519 public key, so there is no phrase to speak. A
        // fingerprint over the wrong bytes would be compared and would appear
        // to work, so the roster carries null rather than inventing one.
        fingerprint: null,
        agents: []
      }
    ])
  })

  it('shows an EXPORTED agent nobody can call — the other half-made grant', () => {
    const r = roster({ exports: [exported({ callers: [] })] })
    expect(r.agents).toEqual([{ nodeId: 'node-1', callers: [], inFlight: 0 }])
  })

  it('counts the calls running against each agent right now', () => {
    const r = roster({
      exports: [exported({ nodeId: 'node-1' }), exported({ nodeId: 'node-2' })],
      live: [
        { workspaceId: 'w1', sub: 'buyer-1', nodeId: 'node-1' },
        { workspaceId: 'w1', sub: 'buyer-2', nodeId: 'node-1' }
      ]
    })
    expect(r.agents.map((a) => [a.nodeId, a.inFlight])).toEqual([
      ['node-1', 2],
      ['node-2', 0]
    ])
  })

  it('lists the live calls themselves, because that is what a revoke stops', () => {
    const live = [{ workspaceId: 'w1', sub: 'buyer-1', nodeId: 'node-1' }]
    expect(roster({ live }).live).toEqual([{ sub: 'buyer-1', nodeId: 'node-1' }])
  })

  it('a caller granted an agent that is no longer exported shows no phantom reach', () => {
    // The export was withdrawn; the enrolment was not. The caller is still
    // enrolled and can call nothing, and the roster must not imply otherwise.
    const r = roster({ callers: [enrolled()], exports: [] })
    expect(r.callers[0].agents).toEqual([])
  })
})

describe('the key fingerprint', () => {
  it('is stable for the same key and different for another', () => {
    expect(keyFingerprint(JWK)).toBe(keyFingerprint({ ...JWK }))
    expect(keyFingerprint(JWK)).not.toBe(keyFingerprint(OTHER_JWK))
  })

  it('does not depend on how the key object happened to be ordered', () => {
    // Two records of the SAME key must not read as two different keys, or a
    // surface built on this would report a key rotation that never happened.
    expect(keyFingerprint({ kty: 'OKP', crv: 'Ed25519', x: 'abc123' })).toBe(
      keyFingerprint({ x: 'abc123', crv: 'Ed25519', kty: 'OKP' })
    )
  })

  it('is short enough to read aloud and long enough to tell keys apart', () => {
    expect(keyFingerprint(JWK)).toMatch(/^[a-f0-9]{16}$/)
  })
})
