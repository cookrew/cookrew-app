import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CallCredentialService } from '../src/main/call-credential'
import { callAssertionPayload } from '../src/main/call-ceremony'
import { ServedCallers } from '../src/main/served-callers'
import { handleServedRoute, type ServedEndpointDeps } from '../src/main/served-endpoints'
import {
  createRegistryTokenVerifier,
  verifyRegistryToken,
  type RegistryKeySource
} from '../src/main/registry-token'
import type { ServedTemplate } from '../src/main/session-served'

/**
 * SIGN IN WITH A REGISTRY TOKEN — the second body form at POST /api/call/assert.
 *
 * A caller who signed in at cookrew.dev holds a short-lived `call` token the
 * registry minted FOR ONE DOOR. The door checks it against the registry's
 * public key and seats the caller as `acct-<handle>` — a namespace the
 * key-based (TOFU) sign-in can never produce, so the two kinds of caller
 * cannot collide on a session directory. Real ed25519 throughout; the only
 * stand-in is the key source, which is a seam so no test needs a registry.
 */

const HANDLE = 'drej'
const SLUG = 'cookrew-alpha'
const DOOR = `@${HANDLE}/${SLUG}`
const NOW = 1_800_000_000_000

const TEMPLATE: ServedTemplate = Object.freeze({
  serviceId: 'svc-cookrew-alpha',
  templateId: 'cookrew-alpha',
  slug: SLUG,
  access: 'account' as const
})

const registryKeys = generateKeyPairSync('ed25519')
const strangerKeys = generateKeyPairSync('ed25519')
const jwkOf = (key: KeyObject): Record<string, unknown> =>
  key.export({ format: 'jwk' }) as Record<string, unknown>

const b64 = (value: string | Buffer): string => Buffer.from(value).toString('base64url')

/** Mint exactly what registry/src/identity.ts mints: `${body}.${sig}`. */
function mintToken(
  claims: Record<string, unknown>,
  key: KeyObject = registryKeys.privateKey
): string {
  const body = b64(JSON.stringify(claims))
  return `${body}.${b64(sign(null, Buffer.from(body, 'utf8'), key))}`
}

const good = (over: Record<string, unknown> = {}): string =>
  mintToken({ sub: 'ana', scope: 'call', exp: NOW + 60_000, aud: DOOR, ...over })

const registryJwk = jwkOf(registryKeys.publicKey)

describe('verifyRegistryToken — the pure check', () => {
  it('accepts a call token for this door, signed by the registry, not yet expired', () => {
    expect(verifyRegistryToken(good(), registryJwk, DOOR, NOW)).toEqual({ sub: 'ana' })
  })

  it('refuses a token for another door', () => {
    expect(verifyRegistryToken(good({ aud: '@drej/other' }), registryJwk, DOOR, NOW)).toBeNull()
  })

  it('refuses a token with no audience', () => {
    expect(verifyRegistryToken(good({ aud: undefined }), registryJwk, DOOR, NOW)).toBeNull()
  })

  it('refuses an expired token', () => {
    expect(verifyRegistryToken(good({ exp: NOW - 1 }), registryJwk, DOOR, NOW)).toBeNull()
  })

  it('refuses a download token and a publish token — only a call token seats a caller', () => {
    expect(verifyRegistryToken(good({ scope: 'download' }), registryJwk, DOOR, NOW)).toBeNull()
    expect(verifyRegistryToken(good({ scope: 'publish' }), registryJwk, DOOR, NOW)).toBeNull()
  })

  it('refuses a token signed by anyone but the registry', () => {
    const forged = mintToken(
      { sub: 'ana', scope: 'call', exp: NOW + 60_000, aud: DOOR },
      strangerKeys.privateKey
    )
    expect(verifyRegistryToken(forged, registryJwk, DOOR, NOW)).toBeNull()
  })

  it('refuses a sub that is not a handle', () => {
    for (const sub of ['Ana', 'a.n.a', '-ana', 'ana-', '', 'a'.repeat(33), 'an_a']) {
      expect(verifyRegistryToken(good({ sub }), registryJwk, DOOR, NOW)).toBeNull()
    }
  })

  it('refuses the malformed: no dot, bad base64, a body that is not JSON, a tampered body', () => {
    expect(verifyRegistryToken('', registryJwk, DOOR, NOW)).toBeNull()
    expect(verifyRegistryToken('nodot', registryJwk, DOOR, NOW)).toBeNull()
    expect(verifyRegistryToken('a.b.c', registryJwk, DOOR, NOW)).toBeNull()
    const [, sig] = good().split('.')
    expect(verifyRegistryToken(`${b64('not json')}.${sig}`, registryJwk, DOOR, NOW)).toBeNull()
    const tampered = `${b64(JSON.stringify({ sub: 'eve', scope: 'call', exp: NOW + 1, aud: DOOR }))}.${sig}`
    expect(verifyRegistryToken(tampered, registryJwk, DOOR, NOW)).toBeNull()
  })

  it('refuses a key that is not an Ed25519 JWK', () => {
    expect(verifyRegistryToken(good(), { kty: 'RSA' }, DOOR, NOW)).toBeNull()
  })
})

describe('createRegistryTokenVerifier — the cached key, and one refetch on failure', () => {
  const source = (keys: readonly (Record<string, unknown> | null)[]): RegistryKeySource & { fetched: number } => {
    const state = { fetched: 0 }
    return {
      get fetched() {
        return state.fetched
      },
      fetch: async () => {
        const key = keys[Math.min(state.fetched, keys.length - 1)] ?? null
        state.fetched += 1
        return key
      }
    }
  }

  it('fetches the key once and verifies against it thereafter', async () => {
    const keys = source([registryJwk])
    const verifier = createRegistryTokenVerifier({ keys, now: () => NOW })
    expect(await verifier.verify(good(), DOOR)).toEqual({ sub: 'ana' })
    expect(await verifier.verify(good({ sub: 'bo' }), DOOR)).toEqual({ sub: 'bo' })
    expect(keys.fetched).toBe(1)
  })

  it('refetches ONCE when a signature fails — the registry may have rotated', async () => {
    const rotated = generateKeyPairSync('ed25519')
    const keys = source([registryJwk, jwkOf(rotated.publicKey)])
    const verifier = createRegistryTokenVerifier({ keys, now: () => NOW })
    const fresh = mintToken(
      { sub: 'ana', scope: 'call', exp: NOW + 60_000, aud: DOOR },
      rotated.privateKey
    )
    expect(await verifier.verify(fresh, DOOR)).toEqual({ sub: 'ana' })
    expect(keys.fetched).toBe(2)
  })

  it('does not refetch for a forgery that fails against the fresh key too', async () => {
    const keys = source([registryJwk])
    const verifier = createRegistryTokenVerifier({ keys, now: () => NOW })
    const forged = mintToken(
      { sub: 'ana', scope: 'call', exp: NOW + 60_000, aud: DOOR },
      strangerKeys.privateKey
    )
    expect(await verifier.verify(forged, DOOR)).toBeNull()
    expect(keys.fetched).toBe(2)
    // The second miss does not keep hammering the registry.
    expect(await verifier.verify(forged, DOOR)).toBeNull()
    expect(keys.fetched).toBe(3)
  })

  it('does not refetch for a token that fails on its claims — the key was fine', async () => {
    const keys = source([registryJwk])
    const verifier = createRegistryTokenVerifier({ keys, now: () => NOW })
    expect(await verifier.verify(good({ exp: NOW - 1 }), DOOR)).toBeNull()
    expect(keys.fetched).toBe(1)
  })

  it('refetches after the cache hour', async () => {
    const keys = source([registryJwk])
    let now = NOW
    const verifier = createRegistryTokenVerifier({ keys, now: () => now })
    expect(await verifier.verify(good(), DOOR)).toEqual({ sub: 'ana' })
    now = NOW + 61 * 60_000
    expect(await verifier.verify(good({ exp: now + 1 }), DOOR)).toEqual({ sub: 'ana' })
    expect(keys.fetched).toBe(2)
  })

  it('refuses everything while the registry has no key to give', async () => {
    const keys = source([null])
    const verifier = createRegistryTokenVerifier({ keys, now: () => NOW })
    expect(await verifier.verify(good(), DOOR)).toBeNull()
  })

  it('refuses a key source that throws, rather than letting the throw reach the gate', async () => {
    const verifier = createRegistryTokenVerifier({
      keys: { fetch: async () => { throw new Error('registry down') } },
      now: () => NOW
    })
    expect(await verifier.verify(good(), DOOR)).toBeNull()
  })
})

describe('POST /api/call/assert with { registryToken }', () => {
  let base = ''
  let issuer: CallCredentialService
  let callers: ServedCallers
  let deps: ServedEndpointDeps

  const unused = (): never => {
    throw new Error('not reached by sign-in')
  }

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'served-registry-token-'))
    issuer = new CallCredentialService({ base })
    callers = new ServedCallers()
    deps = {
      issuer,
      callers,
      doorName: (template) => (template.slug === SLUG ? DOOR : null),
      registryTokens: createRegistryTokenVerifier({
        keys: { fetch: async () => registryJwk },
        now: () => NOW
      }),
      admit: async () => unused(),
      hasOpenSession: () => false,
      endSession: () => false,
      grantBudget: { allowsNewSession: () => true },
      conductorFor: () => null,
      ask: async () => unused(),
      sessionForCaller: () => null,
      turns: { history: () => [] },
      traces: {
        index: async () => [],
        boundaryMarkers: async () => [],
        page: async () => ({ blocks: [], total: 0, source: 'claude' as const })
      },
      settle: async () => 'refused' as const,
      paymentTerms: () => null,
      crewFace: (t) => ({
        name: 'COOKREW Alpha',
        serviceId: t.serviceId,
        slug: t.slug,
        address: `http://127.0.0.1:8639/${t.slug}`,
        version: 1,
        access: t.access,
        door: 'Pilot',
        agents: 2
      })
    }
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))

  const assert = (template: ServedTemplate, body: unknown): ReturnType<typeof handleServedRoute> =>
    handleServedRoute(deps, template, 'POST', '/api/call/assert', { headers: {}, body })

  it('seats a registry-signed caller as acct-<handle>', async () => {
    const res = await assert(TEMPLATE, { registryToken: good() })
    expect(res!.status).toBe(200)
    const token = (res!.body as { token: string }).token
    expect(issuer.verifyToken(token)).toMatchObject({ sub: `acct-${'ana'}`, workspace: TEMPLATE.serviceId })
  })

  it('never enrols a key for a registry caller — there is none to enrol', async () => {
    await assert(TEMPLATE, { registryToken: good() })
    expect(callers.keyOf(TEMPLATE.serviceId, 'acct-ana')).toBeNull()
    expect(callers.keyOf(TEMPLATE.serviceId, 'ana')).toBeNull()
  })

  it('answers the same bare 401 for every refusal', async () => {
    const refusals: unknown[] = [
      { registryToken: good({ aud: '@drej/other' }) },
      { registryToken: good({ exp: NOW - 1 }) },
      { registryToken: good({ scope: 'download' }) },
      { registryToken: mintToken({ sub: 'ana', scope: 'call', exp: NOW + 1, aud: DOOR }, strangerKeys.privateKey) },
      { registryToken: 'malformed' },
      { registryToken: '' },
      { registryToken: 42 },
      { registryToken: good(), sub: 'ana' }
    ]
    for (const body of refusals) {
      const res = await assert(TEMPLATE, body)
      expect(res!.status).toBe(401)
      expect(res!.body).toEqual({})
    }
  })

  it('refuses a door that is not on the relay — it has no name a token could be for', async () => {
    const lan: ServedTemplate = { ...TEMPLATE, slug: 'lan-only', serviceId: 'svc-lan' }
    const res = await assert(lan, { registryToken: good({ aud: '@drej/lan-only' }) })
    expect(res!.status).toBe(401)
  })

  it('refuses a registry token when no verifier is wired at all', async () => {
    const { registryTokens: _dropped, ...without } = deps
    const res = await handleServedRoute(without, TEMPLATE, 'POST', '/api/call/assert', {
      headers: {},
      body: { registryToken: good() }
    })
    expect(res!.status).toBe(401)
  })

  it('the key-based sign-in refuses a sub in the account namespace', async () => {
    const caller = generateKeyPairSync('ed25519')
    const ch = await handleServedRoute(deps, TEMPLATE, 'POST', '/api/call/challenge', { headers: {}, body: null })
    const challenge = (ch!.body as { challenge: string }).challenge
    const sub = 'acct-x'
    const signature = sign(
      null,
      Buffer.from(callAssertionPayload(TEMPLATE.serviceId, sub, challenge), 'utf8'),
      caller.privateKey
    ).toString('base64url')
    const res = await assert(TEMPLATE, { sub, challenge, signature, jwk: jwkOf(caller.publicKey) })
    expect(res!.status).toBe(401)
    expect(callers.keyOf(TEMPLATE.serviceId, sub)).toBeNull()
  })

  it('the key-based sign-in still works for an ordinary sub', async () => {
    const caller = generateKeyPairSync('ed25519')
    const ch = await handleServedRoute(deps, TEMPLATE, 'POST', '/api/call/challenge', { headers: {}, body: null })
    const challenge = (ch!.body as { challenge: string }).challenge
    const signature = sign(
      null,
      Buffer.from(callAssertionPayload(TEMPLATE.serviceId, 'ana', challenge), 'utf8'),
      caller.privateKey
    ).toString('base64url')
    const res = await assert(TEMPLATE, { sub: 'ana', challenge, signature, jwk: jwkOf(caller.publicKey) })
    expect(res!.status).toBe(200)
  })
})
