import { describe, expect, it } from 'vitest'
import http from 'node:http'
import { Readable } from 'node:stream'
import { generateKeyPairSync } from 'node:crypto'
import { openAccount, type AccountFile, type AccountSession } from '../src/main/account'
import { bindPairedDevice, DEVICE_ID } from '../src/main/pair-device'
import { handleMobileApi, type MobileApiDeps } from '../src/main/mobile-api'
import { bindMessage, jwkThumbprint } from '../src/main/registry-assertion'
import {
  bindPhoneDevice,
  canonicalJwk,
  deviceIdFromDigest,
  type PhoneBinding
} from '../src/renderer/src/phone-device'

/**
 * THE PHONE BINDS AT PAIRING (D2) — one route, no prompt.
 *
 * The phone mints its own key on first load and posts the public half over the
 * paired channel. The desktop countersigns with the account key and forwards
 * it to the registry; the phone gets back the handle it is now part of.
 *
 * Everything here is real crypto against a FAKE registry: the point of the
 * test is the sentence a phone is told and the bytes the desktop signs, and
 * neither needs a server on the other end.
 */

const REGISTRY = 'https://registry.test'
const desktop = generateKeyPairSync('ed25519')
const phone = generateKeyPairSync('ed25519')
const phoneJwk = phone.publicKey.export({ format: 'jwk' }) as Record<string, unknown>

const STORED: AccountFile = Object.freeze({
  handle: 'mira',
  deviceId: 'd_desktop',
  kind: 'desktop' as const,
  name: 'MacBook',
  privateKeyJwk: desktop.privateKey.export({ format: 'jwk' }) as Record<string, unknown>,
  publicKeyJwk: desktop.publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
  registry: REGISTRY,
  mintedAt: '2026-09-05T00:00:00.000Z'
})

const token = (claims: Record<string, unknown>): string =>
  `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.sig`

function fakeRegistry(
  bindAnswer: (body: Record<string, unknown>) => Response
): { session: AccountSession; bound: Record<string, unknown>[] } {
  const bound: Record<string, unknown>[] = []
  const fetchStub = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    if (url.pathname === '/v1/identity/challenge') {
      return Response.json({ challenge: 'nonce-1' })
    }
    if (url.pathname === '/v1/identity/assert') {
      return Response.json({ token: token({ sub: 'mira', dev: 'd_desktop', exp: 2e12 }) })
    }
    if (url.pathname === '/v1/accounts/@mira/devices') {
      bound.push(body)
      return bindAnswer(body)
    }
    return new Response('{}', { status: 404 })
  }) as typeof globalThis.fetch
  return { session: openAccount(STORED, { fetch: fetchStub }), bound }
}

const good = { id: 'd_phone_001', jwk: phoneJwk, kind: 'phone', name: 'iPhone' }

describe('bindPairedDevice', () => {
  it('binds the phone and answers with the account it joined', async () => {
    const { session, bound } = fakeRegistry(() =>
      Response.json({ deviceId: 'd_phone_001' }, { status: 201 })
    )
    const out = await bindPairedDevice(good, () => session)

    expect(out.status).toBe(200)
    expect(out.body).toEqual({ handle: 'mira', deviceId: 'd_phone_001' })
    // The vouch is a signature over the ONE sentence, naming the phone's key
    // by thumbprint — not the key itself, so it cannot be replayed over a
    // record whose jwk was swapped on the way.
    expect(bound[0].vouch).toBeTruthy()
    expect(bindMessage('mira', 'd_phone_001', jwkThumbprint(phoneJwk))).toContain('cookrew-bind/1')
    expect((bound[0].device as { kind: string }).kind).toBe('phone')
  })

  it('409s with a sentence naming the DESKTOP when no username exists yet', async () => {
    const out = await bindPairedDevice(good, () => null)
    expect(out.status).toBe(409)
    // Not a 401: the phone's credential is fine, and retrying it changes
    // nothing. The missing thing is on the other machine, so say so.
    expect(String(out.body.error)).toContain('desktop')
  })

  it('refuses a body that is not a phone device', async () => {
    const { session } = fakeRegistry(() => Response.json({}, { status: 201 }))
    const refusals: unknown[] = [
      null,
      'nope',
      { ...good, kind: 'desktop' },
      { ...good, kind: 'passkey' },
      { ...good, id: 'has/slash' },
      { ...good, id: 'sh' },
      { ...good, jwk: 'not-a-key' },
      { ...good, jwk: {} },
      // A private half is a refusal, not something to quietly strip.
      { ...good, jwk: { ...phoneJwk, d: 'secret' } }
    ]
    for (const body of refusals) {
      expect((await bindPairedDevice(body, () => session)).status).toBe(400)
    }
  })

  it('names a registry refusal without claiming the phone is signed in', async () => {
    const { session } = fakeRegistry(() => new Response('{}', { status: 403 }))
    const out = await bindPairedDevice(good, () => session)
    expect(out.status).toBe(502)
    expect(String(out.body.error)).toContain('not signed in as you yet')
  })

  it('gives a nameless phone a name rather than an empty one', async () => {
    const { session, bound } = fakeRegistry(() => Response.json({ deviceId: 'd' }, { status: 201 }))
    await bindPairedDevice({ ...good, name: '   ' }, () => session)
    expect((bound[0].device as { name: string }).name).toBe('a phone')
  })
})

describe('POST /api/pair/device', () => {
  const TOKEN = 'pairing-token-that-is-long-enough'

  const request = (body: unknown, authorization?: string): http.IncomingMessage => {
    const stream = Readable.from([JSON.stringify(body)]) as http.IncomingMessage
    stream.method = 'POST'
    stream.headers = authorization ? { authorization } : {}
    return stream
  }

  const response = (): { res: http.ServerResponse; out: { status: number; body: unknown } } => {
    const out = { status: 0, body: undefined as unknown }
    const res = {
      writeHead(status: number) {
        out.status = status
        return this
      },
      end(raw?: string) {
        out.body = raw ? JSON.parse(raw) : undefined
      }
    } as unknown as http.ServerResponse
    return { res, out }
  }

  const call = async (
    body: unknown,
    deps: Partial<MobileApiDeps>,
    authorization = `Bearer ${TOKEN}`
  ): Promise<{ status: number; body: unknown }> => {
    const { res, out } = response()
    const handled = await handleMobileApi(
      request(body, authorization),
      res,
      new URL('/api/pair/device', 'http://phone.local'),
      { pairingToken: TOKEN, ...deps } as unknown as MobileApiDeps
    )
    expect(handled).toBe(true)
    return out
  }

  it('is behind the pairing token like every other mutating route', async () => {
    const { session } = fakeRegistry(() => Response.json({ deviceId: 'd' }, { status: 201 }))
    const refused = await call(good, { account: () => session }, 'Bearer wrong')
    expect(refused.status).toBe(401)
  })

  it('binds through the route and returns the handle to the phone', async () => {
    const { session } = fakeRegistry(() =>
      Response.json({ deviceId: 'd_phone_001' }, { status: 201 })
    )
    const out = await call(good, { account: () => session })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ handle: 'mira', deviceId: 'd_phone_001' })
  })

  it('409s when the desktop has no username, with no account dep wired at all', async () => {
    const out = await call(good, {})
    expect(out.status).toBe(409)
    expect(String((out.body as { error: string }).error)).toContain('username')
  })
})

describe('the phone half — bind once, and repeat the desktop verbatim', () => {
  const device = { id: 'd_phone_001', alg: 'Ed25519' as const, jwk: phoneJwk }

  it('posts the public half and remembers what came back', async () => {
    const posted: unknown[] = []
    const remembered: PhoneBinding[] = []
    const outcome = await bindPhoneDevice({
      device,
      known: null,
      name: 'an iPhone',
      remember: (bound) => {
        remembered.push(bound)
      },
      post: async (body) => {
        posted.push(body)
        return { status: 200, body: { handle: 'mira', deviceId: 'd_phone_001' } }
      }
    })

    expect(outcome).toEqual({ state: 'bound', handle: 'mira', deviceId: 'd_phone_001' })
    expect(posted[0]).toEqual({
      id: 'd_phone_001',
      jwk: phoneJwk,
      kind: 'phone',
      name: 'an iPhone'
    })
    expect(remembered).toEqual([{ handle: 'mira', deviceId: 'd_phone_001' }])
  })

  it('does NOT re-post once bound — pairing happens on every boot', async () => {
    let posts = 0
    const outcome = await bindPhoneDevice({
      device,
      known: { handle: 'mira', deviceId: 'd_phone_001' },
      remember: () => undefined,
      post: async () => {
        posts += 1
        return { status: 200, body: {} }
      }
    })
    expect(outcome).toEqual({ state: 'already', handle: 'mira' })
    expect(posts).toBe(0)
  })

  it('shows the DESKTOP\'s sentence for a 409, not a sentence of its own', async () => {
    const said = 'this Cookrew has not picked a username yet — open it on the desktop'
    const outcome = await bindPhoneDevice({
      device,
      known: null,
      remember: () => undefined,
      post: async () => ({ status: 409, body: { error: said } })
    })
    // The 409 is the only instruction the person can act on. Rewriting it into
    // "binding failed" would take that away.
    expect(outcome).toEqual({ state: 'refused', reason: said })
  })

  it('never claims a binding from a malformed answer', async () => {
    let remembered = 0
    const outcome = await bindPhoneDevice({
      device,
      known: null,
      remember: () => {
        remembered += 1
      },
      post: async () => ({ status: 200, body: { handle: 'mira' } })
    })
    expect(outcome.state).toBe('refused')
    expect(remembered).toBe(0)
  })

  it('says the desktop is unreachable rather than throwing into the boot path', async () => {
    const outcome = await bindPhoneDevice({
      device,
      known: null,
      remember: () => undefined,
      post: async () => {
        throw new Error('offline')
      }
    })
    expect(outcome).toEqual({
      state: 'refused',
      reason: 'the desktop did not answer — try again in a moment'
    })
  })

  it('derives one id from one key — a lost id is not a second device', () => {
    // Same key, same canonical JSON, same digest, same id.
    expect(canonicalJwk(phoneJwk)).toBe(canonicalJwk({ ...phoneJwk, ext: true, key_ops: ['verify'] }))
    const digest = new Uint8Array(32).fill(7)
    expect(deviceIdFromDigest(digest)).toBe(deviceIdFromDigest(digest))
    // And it survives the desktop's own shape check.
    expect(DEVICE_ID.test(deviceIdFromDigest(digest))).toBe(true)
  })

  it('agrees with the desktop about what a key is called', async () => {
    // The phone hashes canonicalJwk(); the desktop hashes RFC 7638 members.
    // If these ever disagree the vouch names a key the registry cannot find.
    const { createHash } = await import('node:crypto')
    const phoneSide = createHash('sha256').update(canonicalJwk(phoneJwk), 'utf8').digest('base64url')
    expect(phoneSide).toBe(jwkThumbprint(phoneJwk))
  })
})
