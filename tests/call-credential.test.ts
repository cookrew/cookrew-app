import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CallCredentialService, type CallScope } from '../src/main/call-credential'
import { makeCallAuthorize, type CallTarget } from '../src/main/call-authorize'
import type { Visibility } from '../src/shared/gate'

/**
 * THE OWNER'S ISSUER AND THE LIVE-CALL BINDING (④ · S1).
 *
 * The credential the app mints names ONE workspace, and the gate refuses it
 * anywhere else. That refusal is Magpie's R2, which could not previously even
 * be expressed: there was one pairing token for the whole app.
 */

const DEV: CallTarget = { workspaceId: 'ws-cookrew-dev', agent: 'forge' }
const PLAY: CallTarget = { workspaceId: 'ws-playground', agent: 'forge' }

let base = ''
let clock = 1_700_000_000_000
let issuer: CallCredentialService

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'cookrew-call-'))
  clock = 1_700_000_000_000
  issuer = new CallCredentialService({ base, now: () => clock })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** The M1 binding: every exported agent is identified, nobody is unentitled. */
const gate = (
  exported: (target: CallTarget) => Visibility | null = () => 'identified',
  entitled: () => string | null = () => null
): ((target: CallTarget, credential: string | null) => { code: number; reason?: string }) =>
  makeCallAuthorize({ exportedVisibility: exported, issuer, entitled })

describe('CallCredentialService — a credential names one workspace', () => {
  it('mints and verifies, carrying the workspace in the signed claims', () => {
    const token = issuer.mint('alice', 'ws-cookrew-dev')
    expect(issuer.verifyToken(token)).toEqual({
      sub: 'alice',
      scope: 'call',
      workspace: 'ws-cookrew-dev',
      exp: clock + 60 * 60 * 1000
    })
  })

  it('refuses to mint an unscoped credential', () => {
    expect(() => issuer.mint('alice', '')).toThrow(/workspace/)
    expect(() => issuer.mint('', 'ws-cookrew-dev')).toThrow(/subject/)
  })

  it('rejects a tampered workspace — the claim is signed, not advisory', () => {
    const token = issuer.mint('alice', 'ws-cookrew-dev')
    const [body, signature] = token.split('.')
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    const forged = Buffer.from(
      JSON.stringify({ ...claims, workspace: 'ws-playground' }),
      'utf8'
    ).toString('base64url')
    expect(issuer.verifyToken(`${forged}.${signature}`)).toBeNull()
  })

  it('rejects an expired credential exactly as it rejects a forged one', () => {
    const token = issuer.mint('alice', 'ws-cookrew-dev')
    clock += 60 * 60 * 1000 + 1
    expect(issuer.verifyToken(token)).toBeNull()
    expect(issuer.verifyToken('not-a-token')).toBeNull()
    expect(issuer.verifyToken('')).toBeNull()
  })

  it('survives a relaunch — a running conversation is not logged out by a restart', () => {
    const token = issuer.mint('alice', 'ws-cookrew-dev')
    const relaunched = new CallCredentialService({ base, now: () => clock })
    expect(relaunched.verifyToken(token)?.sub).toBe('alice')
  })

  it('does not honour another instance key — the issuer is THIS app', () => {
    const token = issuer.mint('alice', 'ws-cookrew-dev')
    const other = new CallCredentialService({
      base: mkdtempSync(path.join(tmpdir(), 'cookrew-call-other-')),
      now: () => clock
    })
    expect(other.verifyToken(token)).toBeNull()
  })
})

describe('CallCredentialService — the challenge is real, not decorative', () => {
  it('spends a challenge exactly once', () => {
    const nonce = issuer.challenge()
    expect(issuer.consumeChallenge(nonce)).toBe(true)
    expect(issuer.consumeChallenge(nonce)).toBe(false)
  })

  it('refuses an expired challenge, and consumes it anyway', () => {
    const nonce = issuer.challenge()
    clock += 91_000
    expect(issuer.consumeChallenge(nonce)).toBe(false)
  })

  it('refuses a nonce it never issued', () => {
    expect(issuer.consumeChallenge('invented')).toBe(false)
  })

  it('never issues the same nonce twice', () => {
    const seen = new Set(Array.from({ length: 50 }, () => issuer.challenge()))
    expect(seen.size).toBe(50)
  })
})

describe('makeCallAuthorize — the gate mounts per workspace session', () => {
  it('serves a call whose credential names the addressed workspace', () => {
    const verdict = gate()(DEV, issuer.mint('alice', DEV.workspaceId))
    expect(verdict).toEqual({ code: 200, claims: expect.objectContaining({ sub: 'alice' }) })
  })

  it('403s a genuine credential presented at another workspace — R2/D4/R9', () => {
    const forPlayground = issuer.mint('alice', PLAY.workspaceId)
    expect(gate()(DEV, forPlayground)).toEqual({ code: 403, reason: 'workspace' })
  })

  it('403s off-scope, never 401 — re-authenticating cannot fix it', () => {
    const forPlayground = issuer.mint('alice', PLAY.workspaceId)
    // The distinction the whole ruling rests on: 401 invites a retry, 403 does
    // not. A client that got 401 here would present the same token forever.
    expect(gate()(DEV, forPlayground).code).not.toBe(401)
  })

  it('403s a credential carrying a scope that is not a call', () => {
    const wrongScope = issuer.mint('alice', DEV.workspaceId, 'download' as CallScope)
    expect(gate()(DEV, wrongScope)).toEqual({ code: 403, reason: 'scope' })
  })

  it('401s when nothing was presented, and identically when it is junk', () => {
    const missing = gate()(DEV, null)
    const junk = gate()(DEV, 'Bearer-ish nonsense')
    expect(missing.code).toBe(401)
    expect(junk.code).toBe(401)
  })

  it('404s an agent nobody exported — export is explicit, not a default', () => {
    expect(gate(() => null)(DEV, issuer.mint('alice', DEV.workspaceId))).toEqual({ code: 404 })
  })

  it('404s an unexported agent even to a valid credential, before identity', () => {
    // A scoped URL must not confirm what exists outside its scope. An
    // unexported agent and a nonexistent one are one answer.
    expect(gate(() => null)(DEV, null)).toEqual({ code: 404 })
  })

  it('403s an exhausted balance rather than 402 — R5, a call is never interrupted', () => {
    const verdict = gate(
      () => 'identified',
      () => 'balance_empty'
    )(DEV, issuer.mint('alice', DEV.workspaceId))
    expect(verdict).toEqual({ code: 403, reason: 'balance_empty' })
  })

  it('asks the export record about the ADDRESSED workspace, never the focused one', () => {
    const asked: CallTarget[] = []
    gate((target) => {
      asked.push(target)
      return 'identified'
    })(PLAY, issuer.mint('alice', PLAY.workspaceId))
    expect(asked).toEqual([PLAY])
  })
})
