import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { AuthorizationGrants, authorizationRequest, type AuthorizationRequest } from '../registry/src/auth-authorization-grants'

const makeVerifier = (): string => randomBytes(32).toString('base64url')
const challengeOf = (verifier: string): string => createHash('sha256').update(verifier).digest('base64url')
const clientState = randomBytes(32).toString('base64url')
const verifier = makeVerifier()
const challenge = challengeOf(verifier)
const valid = { clientId: 'web', redirectUri: 'https://cookrew.dev/auth/complete', state: clientState, challenge }

function request(input = valid): AuthorizationRequest {
  const parsed = authorizationRequest(input)
  if (parsed === null) throw new Error('valid request refused')
  return parsed
}

describe('authorization requests', () => {
  it('accepts only an explicitly registered client and exact redirect', () => {
    expect(authorizationRequest(valid)).toMatchObject(valid)
    expect(authorizationRequest({ ...valid, clientId: 'desktop', redirectUri: 'cookrew://oauth' })).not.toBeNull()
    for (const bad of [
      { ...valid, clientId: 'unknown' },
      { ...valid, redirectUri: 'https://cookrew.dev.evil.test/auth/complete' },
      { ...valid, redirectUri: 'https://cookrew.dev/auth/complete?next=evil' },
      { ...valid, redirectUri: 'https://cookrew.dev:444/auth/complete' },
      { ...valid, redirectUri: 'http://cookrew.dev/auth/complete' },
      { ...valid, clientId: 'mobile', redirectUri: 'cookrew://oauth' }
    ]) expect(authorizationRequest(bad)).toBeNull()
  })

  it('requires a high entropy state and a SHA-256 PKCE challenge', () => {
    for (const bad of [
      { ...valid, state: '' },
      { ...valid, state: 'short' },
      { ...valid, state: 'x'.repeat(500) },
      { ...valid, challenge: '' },
      { ...valid, challenge: 'x'.repeat(42) },
      { ...valid, challenge: 'x'.repeat(44) },
      { ...valid, challenge: '/'.repeat(43) }
    ]) expect(authorizationRequest(bad)).toBeNull()
  })
})

describe('authorization grants', () => {
  it('binds one use to the exact client and verifier', () => {
    const grants = new AuthorizationGrants({ isLive: () => true })
    const code = grants.issue(request(), { username: 'alice', deviceId: 'dev-1', jti: 'session-1' })
    expect(grants.redeem(code, 'web', verifier)).toMatchObject({ username: 'alice', deviceId: 'dev-1', jti: 'session-1' })
    expect(grants.redeem(code, 'web', verifier)).toBeNull()
  })

  it('rejects and burns a code presented with the wrong verifier or client', () => {
    const grants = new AuthorizationGrants({ isLive: () => true })
    const first = grants.issue(request(), { username: 'alice', deviceId: 'dev-1', jti: 'session-1' })
    expect(grants.redeem(first, 'web', makeVerifier())).toBeNull()
    expect(grants.redeem(first, 'web', verifier)).toBeNull()
    const second = grants.issue(request(), { username: 'alice', deviceId: 'dev-1', jti: 'session-1' })
    expect(grants.redeem(second, 'desktop', verifier)).toBeNull()
    expect(grants.redeem(second, 'web', verifier)).toBeNull()
  })

  it('expires grants, limits their count, and never returns credentials in the redirect', () => {
    let at = 1000
    const grants = new AuthorizationGrants({ now: () => at, ttlMs: 100, max: 2, isLive: () => true })
    const a = grants.issue(request(), { username: 'alice', deviceId: 'dev-1', jti: 'session-1' })
    const b = grants.issue(request(), { username: 'bob', deviceId: 'dev-2', jti: 'session-2' })
    const c = grants.issue(request(), { username: 'carol', deviceId: 'dev-3', jti: 'session-3' })
    expect(grants.redeem(a, 'web', verifier)).toBeNull()
    expect(grants.redeem(b, 'web', verifier)).toMatchObject({ username: 'bob' })
    expect(c).not.toContain('carol')
    at += 100
    expect(grants.redeem(c, 'web', verifier)).toBeNull()
  })
})


it('refuses a revoked session even when the code and verifier are correct', () => {
  let live = true
  const grants = new AuthorizationGrants({ isLive: () => live })
  const code = grants.issue(request(), { username: 'alice', deviceId: 'dev-1', jti: 'session-1' })
  live = false
  expect(grants.redeem(code, 'web', verifier)).toBeNull()
})
