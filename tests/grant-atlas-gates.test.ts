import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentExportStore } from '../src/main/agent-export'
import { OwnerGrant } from '../src/main/owner-grant'
import { buildGrantRoster } from '../src/main/grant-roster'
import { CallsInFlight } from '../src/main/call-inflight'

/**
 * THE GATES VELVET ASSIGNED TO ATLAS (deck §8).
 *
 * She split them deliberately: Magpie owns the four that only a real drive can
 * prove — the ABSENCE of a bulk control, focus behaviour, a click-and-undo, an
 * entry point that must not exist — and these three are assertions about the
 * STORE, "where a unit test is stronger than a screenshot because it can prove
 * a value never arrived". Gate 4 (a private key never reaches the store) lives
 * in caller-key-paste.test.ts beside the parser it constrains.
 *
 * The deck's §6 revoke behaviour is asserted here too, because the undo it
 * promises is a claim about the record even though the toast is Magpie's.
 */

const WS = 'w1'
let base = ''
let store: AgentExportStore
let flight: CallsInFlight
let grant: OwnerGrant

const keyFor = (): Record<string, unknown> =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as Record<string, unknown>

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-atlas-gates-'))
  store = new AgentExportStore(base)
  flight = new CallsInFlight()
  grant = new OwnerGrant({ store, cancelInFlight: (m) => flight.cancelWhere(m) })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const roster = () =>
  buildGrantRoster({
    workspaceId: WS,
    enrolledIn: (w) => store.enrolledIn(w),
    revokedIn: (w) => store.revokedIn(w),
    exportsIn: (w) => store.exportsIn(w),
    callsIn: (w) => flight.listIn(w)
  })

describe('ATLAS gate 3 · enrolling grants nothing', () => {
  it('a freshly enrolled caller has zero agents', () => {
    // The dangerous half is granting, and it must not ride in on the momentum
    // of a sheet the owner was already completing (deck §3).
    expect(grant.enrol(WS, 'kestrel', keyFor())).toEqual({ ok: true })
    const only = roster().callers
    expect(only).toHaveLength(1)
    expect(only[0].agents).toEqual([])
  })

  it('and enrolling a second caller does not widen the first', () => {
    grant.enrol(WS, 'kestrel', keyFor())
    grant.exportAgent(WS, 'node-forge', ['kestrel'])
    grant.enrol(WS, 'magpie-ci', keyFor())
    const byName = Object.fromEntries(roster().callers.map((c) => [c.sub, c.agents]))
    expect(byName).toEqual({ kestrel: ['node-forge'], 'magpie-ci': [] })
  })
})

describe('ATLAS gate 7 · un-exporting an agent drops every grant against it', () => {
  it('every caller of that agent loses it at once', () => {
    for (const sub of ['kestrel', 'magpie-ci']) grant.enrol(WS, sub, keyFor())
    grant.exportAgent(WS, 'node-forge', ['kestrel', 'magpie-ci'])
    grant.exportAgent(WS, 'node-tinker', ['kestrel'])

    expect(grant.unexport(WS, 'node-forge')).toMatchObject({ ok: true })

    const byName = Object.fromEntries(roster().callers.map((c) => [c.sub, c.agents]))
    // The one-switch panic control from deck §1: un-exporting kills every grant
    // against that agent without unpicking a matrix, and touches nothing else.
    expect(byName).toEqual({ kestrel: ['node-tinker'], 'magpie-ci': [] })
    expect(roster().agents.map((a) => a.nodeId)).toEqual(['node-tinker'])
  })
})

describe('§1 · two levels, so one mistake is bounded', () => {
  it('an agent can be EXPORTABLE and granted to nobody', () => {
    // Required by the surface: an agent must be exportable before it can appear
    // in the matrix to be ticked, and "exportable agents, no callers" is one of
    // the deck's named empty states. This used to be refused.
    expect(grant.exportAgent(WS, 'node-forge', [])).toEqual({ ok: true, stopped: undefined })
    expect(roster().agents).toEqual([{ nodeId: 'node-forge', callers: [], inFlight: 0 }])
  })

  it('and exportable-to-nobody still entitles nobody', () => {
    // Allowing the empty list must not loosen the closed default.
    grant.exportAgent(WS, 'node-forge', [])
    expect(store.exportOf(WS, 'node-forge')?.callers).toEqual([])
  })

  it('a caller who is not enrolled cannot be granted', () => {
    expect(grant.exportAgent(WS, 'node-forge', ['stranger'])).toMatchObject({
      ok: false,
      reason: 'not_enrolled'
    })
  })
})

describe('§6 · revoke, and the undo that has nothing to replay', () => {
  it('revoking moves the row to REVOKED and keeps its last-call time', () => {
    grant.enrol(WS, 'kestrel', keyFor())
    grant.exportAgent(WS, 'node-forge', ['kestrel'])
    store.noteCall(WS, 'kestrel', 1_700_000_000_000)

    grant.revoke(WS, 'kestrel')

    const after = roster()
    expect(after.callers).toEqual([])
    expect(after.revoked).toHaveLength(1)
    // "Who used to have access" is a security question people ask after the
    // fact, and a hard delete answers it with silence.
    expect(after.revoked[0].sub).toBe('kestrel')
    expect(after.revoked[0].lastCallAt).toBe(1_700_000_000_000)
    expect(after.revoked[0].revokedAt).toBeTypeOf('number')
  })

  it('a revoked caller is not enrolled, so the gate refuses them', () => {
    grant.enrol(WS, 'kestrel', keyFor())
    grant.revoke(WS, 'kestrel')
    expect(store.enrolledKey(WS, 'kestrel')).toBeNull()
  })

  it('UNDO restores EXACTLY the prior grant set', () => {
    // Exact by construction rather than by bookkeeping: revoking never touched
    // a grant, so there is no saved set to replay and none to replay wrongly.
    grant.enrol(WS, 'kestrel', keyFor())
    grant.exportAgent(WS, 'node-forge', ['kestrel'])
    grant.exportAgent(WS, 'node-tinker', ['kestrel'])
    const before = roster().callers[0].agents

    grant.revoke(WS, 'kestrel')
    expect(grant.restore(WS, 'kestrel')).toEqual({ ok: true })

    const after = roster()
    expect(after.revoked).toEqual([])
    expect(after.callers[0].agents).toEqual(before)
    expect(store.enrolledKey(WS, 'kestrel')).not.toBeNull()
  })

  it('undo after the toast outlived the record says so rather than inventing one', () => {
    expect(grant.restore(WS, 'nobody')).toMatchObject({ ok: false, reason: 'not_enrolled' })
  })

  it('re-enrolling a revoked caller with the SAME key lets them back in', () => {
    // TOFU's "same key → ok" branch used to return ok while leaving them
    // revoked, which reports success for a caller who is still locked out.
    const key = keyFor()
    grant.enrol(WS, 'kestrel', key)
    grant.revoke(WS, 'kestrel')
    expect(grant.enrol(WS, 'kestrel', key)).toEqual({ ok: true })
    expect(store.enrolledKey(WS, 'kestrel')).not.toBeNull()
  })

  it('a revoked caller cannot be re-enrolled under a DIFFERENT key', () => {
    // TOFU still holds across a revoke: reaching this surface is not enough to
    // take over an existing caller's identity.
    grant.enrol(WS, 'kestrel', keyFor())
    grant.revoke(WS, 'kestrel')
    expect(grant.enrol(WS, 'kestrel', keyFor())).toMatchObject({
      ok: false,
      reason: 'caller_exists'
    })
  })

  it('revoke reports how many running calls it stopped', () => {
    grant.enrol(WS, 'kestrel', keyFor())
    grant.exportAgent(WS, 'node-forge', ['kestrel'])
    flight.enter({ workspaceId: WS, sub: 'kestrel', nodeId: 'node-forge' }, () => undefined)
    expect(grant.revoke(WS, 'kestrel')).toEqual({ ok: true, stopped: 1 })
  })
})

describe('§3 · the roster speaks the fingerprint', () => {
  it('every caller carries six words and the matching hex', () => {
    grant.enrol(WS, 'kestrel', keyFor())
    const caller = roster().callers[0]
    expect(caller.fingerprint?.words).toHaveLength(6)
    expect(caller.fingerprint?.hex).toHaveLength(18)
  })

  it('two callers do not speak the same phrase', () => {
    grant.enrol(WS, 'kestrel', keyFor())
    grant.enrol(WS, 'magpie-ci', keyFor())
    const [a, b] = roster().callers
    expect(a.fingerprint?.words).not.toEqual(b.fingerprint?.words)
  })
})
