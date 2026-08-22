import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync, sign, type KeyPairKeyObjectResult } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CallCredentialService } from '../src/main/call-credential'
import { callAssertionPayload, makeCallCeremony } from '../src/main/call-ceremony'
import { makeCallGate } from '../src/main/call-gate'
import { AgentExportStore } from '../src/main/agent-export'
import type { CanvasNode } from '../src/shared/model'

/**
 * THE CEREMONY, AND THE ROUND TRIP (④ · S2).
 *
 * The whole point of landing this with the route: the 401 the gate emits can be
 * ANSWERED. The last describe walks it — refused, ceremony, served — because a
 * challenge that cannot be spent is the same lie as a 401 with no ceremony
 * behind it, just moved one file over.
 */

const WS = 'ws-cookrew-dev'
const OTHER = 'ws-playground'

const terminal = (id: string, name: string): CanvasNode =>
  ({ kind: 'terminal', id, name, preset: 'claude', command: 'claude', cwd: '/tmp',
     orch: false, role: null }) as CanvasNode

const NODES: Record<string, CanvasNode[]> = {
  [WS]: [terminal('node-forge', 'Forge')],
  [OTHER]: [terminal('node-atlas', 'Atlas')]
}

let base = ''
let clock = 1_700_000_000_000
let issuer: CallCredentialService
let exports: AgentExportStore
let caller: KeyPairKeyObjectResult

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-ceremony-'))
  clock = 1_700_000_000_000
  issuer = new CallCredentialService({ base, now: () => clock })
  exports = new AgentExportStore(base)
  caller = generateKeyPairSync('ed25519')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const ceremony = (): ReturnType<typeof makeCallCeremony> =>
  makeCallCeremony({
    issuer,
    enrolledKey: (workspaceId, sub) => exports.enrolledKey(workspaceId, sub)
  })

const gate = (): ReturnType<typeof makeCallGate> =>
  makeCallGate({
    nodesOf: (workspaceId) => NODES[workspaceId] ?? [],
    exportOf: (workspaceId, nodeId) => exports.exportOf(workspaceId, nodeId),
    issuer
  })

const enrolAlice = (workspaceId = WS): void => {
  exports.enrol(workspaceId, 'alice', caller.publicKey.export({ format: 'jwk' }) as Record<string, unknown>)
}

const signFor = (workspaceId: string, sub: string, challenge: string): string =>
  sign(null, Buffer.from(callAssertionPayload(workspaceId, sub, challenge), 'utf8'), caller.privateKey)
    .toString('base64url')

describe('the ceremony — a caller proves possession of an enrolled key', () => {
  it('mints a workspace-scoped credential for an enrolled caller', () => {
    enrolAlice()
    const c = ceremony()
    const challenge = c.challenge(WS)
    const result = c.assert(WS, { sub: 'alice', challenge, signature: signFor(WS, 'alice', challenge) })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(issuer.verifyToken(result.token)).toMatchObject({ sub: 'alice', workspace: WS, scope: 'call' })
  })

  it('refuses a caller nobody enrolled', () => {
    const c = ceremony()
    const challenge = c.challenge(WS)
    expect(c.assert(WS, { sub: 'mallory', challenge, signature: signFor(WS, 'mallory', challenge) }))
      .toEqual({ ok: false, reason: 'unknown_caller' })
  })

  it('refuses a caller enrolled at a DIFFERENT workspace', () => {
    enrolAlice(OTHER)
    const c = ceremony()
    const challenge = c.challenge(WS)
    expect(c.assert(WS, { sub: 'alice', challenge, signature: signFor(WS, 'alice', challenge) }))
      .toEqual({ ok: false, reason: 'unknown_caller' })
  })

  it('refuses a signature made by the wrong key', () => {
    enrolAlice()
    const impostor = generateKeyPairSync('ed25519')
    const c = ceremony()
    const challenge = c.challenge(WS)
    const signature = sign(
      null,
      Buffer.from(callAssertionPayload(WS, 'alice', challenge), 'utf8'),
      impostor.privateKey
    ).toString('base64url')
    expect(c.assert(WS, { sub: 'alice', challenge, signature })).toEqual({
      ok: false,
      reason: 'bad_signature'
    })
  })

  it('refuses a signature over a DIFFERENT workspace, even with a good nonce', () => {
    enrolAlice()
    enrolAlice(OTHER)
    const c = ceremony()
    const challenge = c.challenge(WS)
    // Signed for OTHER, presented at WS. The workspace is inside the signed
    // bytes, so the signature does not verify here.
    expect(c.assert(WS, { sub: 'alice', challenge, signature: signFor(OTHER, 'alice', challenge) }))
      .toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('spends a nonce even when the attempt fails', () => {
    enrolAlice()
    const c = ceremony()
    const challenge = c.challenge(WS)
    c.assert(WS, { sub: 'alice', challenge, signature: 'garbage' })
    // A nonce that survived a failed attempt is one an attacker keeps trying.
    expect(c.assert(WS, { sub: 'alice', challenge, signature: signFor(WS, 'alice', challenge) }))
      .toEqual({ ok: false, reason: 'unknown_challenge' })
  })

  it('refuses a nonce issued by ANOTHER workspace', () => {
    enrolAlice()
    const c = ceremony()
    const challenge = c.challenge(OTHER)
    expect(c.assert(WS, { sub: 'alice', challenge, signature: signFor(WS, 'alice', challenge) }))
      .toEqual({ ok: false, reason: 'unknown_challenge' })
  })

  it('refuses an expired nonce', () => {
    enrolAlice()
    const c = ceremony()
    const challenge = c.challenge(WS)
    clock += 91_000
    expect(c.assert(WS, { sub: 'alice', challenge, signature: signFor(WS, 'alice', challenge) }))
      .toEqual({ ok: false, reason: 'unknown_challenge' })
  })

  it('refuses a malformed body without consuming anything', () => {
    const c = ceremony()
    expect(c.assert(WS, {} as never)).toEqual({ ok: false, reason: 'malformed' })
  })
})

describe('the round trip — 401, ceremony, served', () => {
  beforeEach(() => {
    enrolAlice()
    exports.exportAgent({
      workspaceId: WS,
      nodeId: 'node-forge',
      visibility: 'identified',
      callers: ['alice']
    })
  })

  it('refuses with a challenge, then serves the same call after the ceremony', () => {
    const refused = gate()(WS, 'forge', null)
    expect(refused.verdict.code).toBe(401)
    if (refused.verdict.code !== 401) return

    // THE PROMISE KEPT: the nonce the gate handed out is spendable, at this
    // workspace, right now. This is the assertion that makes the 401 honest.
    const result = ceremony().assert(WS, {
      sub: 'alice',
      challenge: refused.verdict.challenge,
      signature: signFor(WS, 'alice', refused.verdict.challenge)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const served = gate()(WS, 'forge', result.token)
    expect(served.verdict.code).toBe(200)
    expect(served.target).toEqual({ workspaceId: WS, nodeId: 'node-forge' })
  })

  it('403s the minted credential at another workspace', () => {
    const challenge = ceremony().challenge(WS)
    const result = ceremony().assert(WS, {
      sub: 'alice',
      challenge,
      signature: signFor(WS, 'alice', challenge)
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    exports.exportAgent({
      workspaceId: OTHER,
      nodeId: 'node-atlas',
      visibility: 'identified',
      callers: ['alice']
    })
    expect(gate()(OTHER, 'atlas', result.token).verdict).toEqual({
      code: 403,
      reason: 'workspace'
    })
  })
})

describe('the gate over real grants', () => {
  const credential = (): string => {
    enrolAlice()
    const challenge = ceremony().challenge(WS)
    const result = ceremony().assert(WS, {
      sub: 'alice',
      challenge,
      signature: signFor(WS, 'alice', challenge)
    })
    if (!result.ok) throw new Error('ceremony failed')
    return result.token
  }

  it('404s an agent that exists but is not exported', () => {
    const token = credential()
    expect(gate()(WS, 'forge', token).verdict).toEqual({ code: 404 })
  })

  it('404s a name that resolves to nothing, identically', () => {
    const token = credential()
    expect(gate()(WS, 'nobody', token).verdict).toEqual({ code: 404 })
  })

  it('404s before asking for a credential, so 404 and 401 cannot map the room', () => {
    // A caller must not learn which agents exist by watching the code change.
    expect(gate()(WS, 'forge', null).verdict).toEqual({ code: 404 })
    expect(gate()(WS, 'nobody', null).verdict).toEqual({ code: 404 })
  })

  it('403s an exported agent whose caller list does not name this subject', () => {
    const token = credential()
    exports.exportAgent({
      workspaceId: WS,
      nodeId: 'node-forge',
      visibility: 'identified',
      callers: ['bob']
    })
    expect(gate()(WS, 'forge', token).verdict).toEqual({ code: 403, reason: 'entitlement' })
  })

  it('403s an export with an EMPTY caller list — empty means nobody', () => {
    const token = credential()
    exports.exportAgent({
      workspaceId: WS,
      nodeId: 'node-forge',
      visibility: 'identified',
      callers: []
    })
    expect(gate()(WS, 'forge', token).verdict).toEqual({ code: 403, reason: 'entitlement' })
  })

  it('serves a public export with no credential at all', () => {
    exports.exportAgent({
      workspaceId: WS,
      nodeId: 'node-forge',
      visibility: 'public',
      callers: []
    })
    const decision = gate()(WS, 'forge', null)
    expect(decision.verdict).toEqual({ code: 200, claims: null })
    expect(decision.target).toEqual({ workspaceId: WS, nodeId: 'node-forge' })
  })

  it('never carries a target on a refusal', () => {
    // A caller must not be able to read a node id out of an error.
    enrolAlice()
    exports.exportAgent({
      workspaceId: WS,
      nodeId: 'node-forge',
      visibility: 'identified',
      callers: ['bob']
    })
    for (const credentialValue of [null, 'forged', credential()]) {
      const decision = gate()(WS, 'forge', credentialValue)
      expect(decision.verdict.code).not.toBe(200)
      expect(decision.target).toBeNull()
    }
  })

  it('cannot be reached for an agent in another workspace by naming it', () => {
    const token = credential()
    exports.exportAgent({
      workspaceId: OTHER,
      nodeId: 'node-atlas',
      visibility: 'public',
      callers: []
    })
    // 'atlas' is exported — but not HERE, and resolution only ever looks here.
    expect(gate()(WS, 'atlas', token).verdict).toEqual({ code: 404 })
  })
})
