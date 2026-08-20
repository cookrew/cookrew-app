import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { IdentityService, type IdentityConfig } from '../registry/src/identity'
import { makeAuthorize } from '../registry/src/authorize'
import { createRegistry } from '../registry/src/server'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog } from '../registry/src/log'
import { buildManifest, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import { updateCheckOutcome } from '../src/shared/preset-manifest'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const CONFIG: IdentityConfig = {
  rpId: 'localhost',
  origin: 'http://localhost:8790',
  tokenTtlMs: 10 * 60 * 1000,
  challengeTtlMs: 90 * 1000
}

const b64 = (b: Buffer): string => b.toString('base64url')

/** A software authenticator: exactly what a virtual one produces. */
function authenticator(keys: { privateKey: KeyObject }) {
  const rpIdHash = createHash('sha256').update(CONFIG.rpId).digest()
  const authData = (flags = 0x01): Buffer =>
    Buffer.concat([rpIdHash, Buffer.from([flags]), Buffer.from([0, 0, 0, 1])])
  return {
    assert(challenge: string, over: { origin?: string; type?: string; flags?: number } = {}) {
      const clientData = Buffer.from(
        JSON.stringify({
          type: over.type ?? 'webauthn.get',
          origin: over.origin ?? CONFIG.origin,
          challenge
        }),
        'utf8'
      )
      const data = authData(over.flags ?? 0x01)
      const signature = sign(null, Buffer.concat([data, createHash('sha256').update(clientData).digest()]), keys.privateKey)
      return {
        credentialId: 'cred-1',
        clientDataJSON: b64(clientData),
        authenticatorData: b64(data),
        signature: b64(signature)
      }
    }
  }
}

const terminal = (): CanvasNode =>
  ({
    kind: 'terminal', id: 't1', name: 'Forge', preset: 'Claude Code', command: 'npm test',
    cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }
  }) as CanvasNode

function publish(name: string, version: number) {
  const snapshot: TeamSnapshot = { name, savedAt: 1, dir: '/w', nodes: [terminal()], connections: [], turns: {} }
  const { privateKey } = generateKeyPairSync('ed25519')
  const built = buildManifest({ scrub: scrubForPublish(snapshot), version, author: { handle: 'a' } })
  if (!built.ok) throw new Error('refused')
  return { manifest: signManifest(built.manifest, privateKey), teamBytes: built.teamBytes }
}

let base = ''
let identity: IdentityService
let keys: { privateKey: KeyObject; publicKey: KeyObject }
let auth: ReturnType<typeof authenticator>
let now = 1_000_000

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-a2-'))
  now = 1_000_000
  identity = new IdentityService(base, CONFIG, () => now)
  keys = generateKeyPairSync('ed25519')
  identity.register('cred-1', keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>)
  auth = authenticator(keys)
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('IdentityService — assertion verification', () => {
  it('accepts a well-formed assertion and mints a token', () => {
    const out = identity.assert(auth.assert(identity.challenge()))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(identity.verifyToken(out.token)).toMatchObject({ sub: 'cred-1', scope: 'download' })
  })

  it('refuses an unknown credential', () => {
    const a = auth.assert(identity.challenge())
    const out = identity.assert({ ...a, credentialId: 'nobody' })
    expect(out).toEqual({ ok: false, reason: 'unknown_credential' })
  })

  it('refuses a challenge it never issued', () => {
    expect(identity.assert(auth.assert('made-up')).ok).toBe(false)
  })

  it('CONSUMES a challenge, so a captured assertion cannot be replayed', () => {
    const challenge = identity.challenge()
    const assertion = auth.assert(challenge)
    expect(identity.assert(assertion).ok).toBe(true)
    // Byte-identical replay of a valid assertion.
    expect(identity.assert(assertion)).toEqual({ ok: false, reason: 'unknown_challenge' })
  })

  it('refuses an expired challenge', () => {
    const challenge = identity.challenge()
    now += CONFIG.challengeTtlMs + 1
    expect(identity.assert(auth.assert(challenge))).toEqual({ ok: false, reason: 'unknown_challenge' })
  })

  it('refuses a foreign origin, checked against config and never echoed', () => {
    const out = identity.assert(auth.assert(identity.challenge(), { origin: 'http://evil.test' }))
    expect(out).toEqual({ ok: false, reason: 'wrong_origin' })
  })

  it('refuses a create ceremony presented as a get', () => {
    const out = identity.assert(auth.assert(identity.challenge(), { type: 'webauthn.create' }))
    expect(out).toEqual({ ok: false, reason: 'wrong_type' })
  })

  it('refuses an assertion nobody was present for', () => {
    const out = identity.assert(auth.assert(identity.challenge(), { flags: 0x00 }))
    expect(out).toEqual({ ok: false, reason: 'user_not_present' })
  })

  it('refuses a signature from a different key', () => {
    const other = authenticator(generateKeyPairSync('ed25519'))
    expect(identity.assert(other.assert(identity.challenge()))).toEqual({
      ok: false,
      reason: 'bad_signature'
    })
  })

  it('TOFU: a known credential id cannot be re-registered under a new key', () => {
    const attacker = generateKeyPairSync('ed25519')
    const out = identity.register('cred-1', attacker.publicKey.export({ format: 'jwk' }) as Record<string, unknown>)
    expect(out).toEqual({ ok: false, reason: 'credential_exists' })
  })

  it('re-registering the SAME key is idempotent, not an error', () => {
    expect(identity.register('cred-1', keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>).ok).toBe(true)
  })
})

describe('tokens — signed statements, not sessions', () => {
  const token = (): string => {
    const out = identity.assert(auth.assert(identity.challenge()))
    if (!out.ok) throw new Error('assert failed')
    return out.token
  }

  it('expires', () => {
    const t = token()
    expect(identity.verifyToken(t)).not.toBeNull()
    now += CONFIG.tokenTtlMs + 1
    expect(identity.verifyToken(t)).toBeNull()
  })

  it('rejects a tampered payload', () => {
    const [body, sig] = token().split('.')
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    const forged = Buffer.from(JSON.stringify({ ...claims, scope: 'publish' }), 'utf8').toString('base64url')
    expect(identity.verifyToken(`${forged}.${sig}`)).toBeNull()
  })

  it('rejects garbage without throwing', () => {
    for (const bad of ['', 'x', 'a.b', 'not.a.token']) expect(identity.verifyToken(bad)).toBeNull()
  })

  it('survives a restart — a new process reads the same signing key', () => {
    const t = token()
    const reopened = new IdentityService(base, CONFIG, () => now)
    expect(reopened.verifyToken(t)).not.toBeNull()
  })
})

describe('authorize — the 401 path and D4', () => {
  const listen = async (): Promise<{ url: string; close: () => void; id: string }> => {
    const store = new RegistryStore(base)
    const log = new TransparencyLog(base)
    const p = publish('Pro Toolkit', 1)
    store.putBlob(p.teamBytes)
    store.putManifest({ manifest: p.manifest, teamName: 'Pro Toolkit', visibility: 'identified', identityId: 'webauthn:drej' })
    const pub = publish('Deep Research', 2)
    store.putBlob(pub.teamBytes)
    store.putManifest({ manifest: pub.manifest, teamName: 'Deep Research', visibility: 'public', identityId: 'webauthn:drej' })
    const server = createRegistry({ store, log, identity, dev: true, authorize: makeAuthorize(store, identity) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${port}`, close: () => server.close(), id: p.manifest.id }
  }

  it('answers 401 with a challenge in the header the spec names', async () => {
    const s = await listen()
    try {
      const res = await fetch(`${s.url}/v1/presets/${encodeURIComponent(s.id)}/manifest`)
      expect(res.status).toBe(401)
      expect(res.headers.get('www-authenticate')).toMatch(/^WebAuthn realm="market", challenge=/)
    } finally {
      s.close()
    }
  })

  it('serves the manifest after the ceremony, on a retry of the SAME request', async () => {
    const s = await listen()
    try {
      const first = await fetch(`${s.url}/v1/presets/${encodeURIComponent(s.id)}/manifest`)
      const challenge = (first.headers.get('www-authenticate') as string).split('challenge=')[1]
      const assertion = auth.assert(challenge)
      const token = (await (
        await fetch(`${s.url}/v1/identity/assert`, {
          method: 'POST',
          body: JSON.stringify(assertion)
        })
      ).json()) as { token: string }
      const retry = await fetch(`${s.url}/v1/presets/${encodeURIComponent(s.id)}/manifest`, {
        headers: { authorization: `Bearer ${token.token}` }
      })
      expect(retry.status).toBe(200)
    } finally {
      s.close()
    }
  })

  it('D4 OVER HTTP: a publish token minted through the ROUTE gets 403 on a download', async () => {
    // Magpie's C3/C5/C7s were BLOCK because no route passed a scope, so this
    // branch of authorize was unreachable from outside the process. The whole
    // ceremony now runs over the wire: challenge, assert with scope=publish,
    // then present that token to the gate.
    const s = await listen()
    try {
      const first = await fetch(`${s.url}/v1/presets/${encodeURIComponent(s.id)}/manifest`)
      const challenge = (first.headers.get('www-authenticate') as string).split('challenge=')[1]
      const minted = (await (
        await fetch(`${s.url}/v1/identity/assert`, {
          method: 'POST',
          body: JSON.stringify({ ...auth.assert(challenge), scope: 'publish' })
        })
      ).json()) as { token: string; scope: string }
      expect(minted.scope).toBe('publish')
      const res = await fetch(`${s.url}/v1/presets/${encodeURIComponent(s.id)}/manifest`, {
        headers: { authorization: `Bearer ${minted.token}` }
      })
      expect(res.status).toBe(403)
    } finally {
      s.close()
    }
  })

  it('an unrecognised scope falls back to download, never up to publish', async () => {
    const s = await listen()
    try {
      const first = await fetch(`${s.url}/v1/presets/${encodeURIComponent(s.id)}/manifest`)
      const challenge = (first.headers.get('www-authenticate') as string).split('challenge=')[1]
      const minted = (await (
        await fetch(`${s.url}/v1/identity/assert`, {
          method: 'POST',
          body: JSON.stringify({ ...auth.assert(challenge), scope: 'root' })
        })
      ).json()) as { scope: string }
      expect(minted.scope).toBe('download')
    } finally {
      s.close()
    }
  })

  it('D4: a token with the wrong scope answers 403, never 401', async () => {
    // A publish-scoped token is a valid identity that does not cover a
    // download. Answering 401 would make the client re-authenticate, present
    // the same token, and loop forever.
    const out = identity.assert(auth.assert(identity.challenge()), 'publish')
    if (!out.ok) throw new Error('assert failed')
    const s = await listen()
    try {
      const res = await fetch(`${s.url}/v1/presets/${encodeURIComponent(s.id)}/manifest`, {
        headers: { authorization: `Bearer ${out.token}` }
      })
      expect(res.status).toBe(403)
    } finally {
      s.close()
    }
  })

  it('an EXPIRED token answers 401 — a fresh ceremony, not a dead end', async () => {
    const out = identity.assert(auth.assert(identity.challenge()))
    if (!out.ok) throw new Error('assert failed')
    now += CONFIG.tokenTtlMs + 1
    const s = await listen()
    try {
      const res = await fetch(`${s.url}/v1/presets/${encodeURIComponent(s.id)}/manifest`, {
        headers: { authorization: `Bearer ${out.token}` }
      })
      expect(res.status).toBe(401)
    } finally {
      s.close()
    }
  })

  it('a public preset never sees the gate', async () => {
    const s = await listen()
    try {
      const list = (await (await fetch(`${s.url}/v1/presets?q=Deep`)).json()) as {
        presets: { id: string }[]
      }
      const res = await fetch(`${s.url}/v1/presets/${encodeURIComponent(list.presets[0].id)}/manifest`)
      expect(res.status).toBe(200)
    } finally {
      s.close()
    }
  })

  it('R24: the UNGATED search carries visibility, so lock state renders before a click', async () => {
    const s = await listen()
    try {
      const body = (await (await fetch(`${s.url}/v1/presets`)).json()) as {
        presets: { name: string; visibility: string }[]
      }
      const locked = body.presets.find((p) => p.name === 'Pro Toolkit')
      expect(locked?.visibility).toBe('identified')
      // And it arrives with NO credential offered — that is the whole point.
      expect(body.presets.every((p) => typeof p.visibility === 'string')).toBe(true)
    } finally {
      s.close()
    }
  })
})

describe('R24 — a dock-open check never raises a sheet', () => {
  it('is silent on 401, which is what an expired token answers', () => {
    // Opening a dock must never demand a fingerprint. The badge simply does
    // not appear, and the buyer keeps the version they have.
    expect(updateCheckOutcome(401, null, 2)).toBe('silent')
  })

  it('is silent on any refusal or unreachable registry', () => {
    for (const status of [403, 404, 500, 0]) expect(updateCheckOutcome(status, 3, 2)).toBe('silent')
  })

  it('badges only a successful check that is genuinely ahead', () => {
    expect(updateCheckOutcome(200, 3, 2)).toBe('update')
    expect(updateCheckOutcome(200, 2, 2)).toBe('current')
    expect(updateCheckOutcome(200, 1, 2)).toBe('current')
  })
})


describe('dev contract — reconciled with Magpie\'s harness', () => {
  const listen = async (dev: boolean): Promise<{ url: string; close: () => void }> => {
    const store = new RegistryStore(base)
    const log = new TransparencyLog(base)
    const server = createRegistry({ store, log, identity, dev, authorize: makeAuthorize(store, identity) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    return { url: `http://127.0.0.1:${port}`, close: () => server.close() }
  }

  it('/v1/health describes the contract it actually serves', async () => {
    const s = await listen(true)
    try {
      const body = (await (await fetch(`${s.url}/v1/health`)).json()) as {
        ok: boolean
        routes: string[]
        notServed: Record<string, string>
      }
      expect(body.ok).toBe(true)
      expect(body.routes).toContain('GET /v1/presets/:id/manifest')
      expect(body.routes).toContain('POST /v1/identity/assert')
      // R20's rotation sheet links at the log BY PRESET. Advertised, so a
      // harness discovers the parameter instead of assuming the whole chain.
      expect(body.routes).toContain('GET /v1/log?from=&preset=')
      // Named explicitly so nobody builds fixtures against it.
      expect(body.notServed['/v1/pay']).toContain('M2 mounts 402 on the manifest gate')
    } finally {
      s.close()
    }
  })

  it('/v1/dev/identities lists enrolled credentials, so a matrix can assert', async () => {
    const s = await listen(true)
    try {
      const body = (await (await fetch(`${s.url}/v1/dev/identities`)).json()) as {
        credentials: string[]
      }
      expect(body.credentials).toContain('cred-1')
    } finally {
      s.close()
    }
  })

  it('/v1/dev/identities DELETE resets, so a run starts from a known state', async () => {
    const s = await listen(true)
    try {
      expect((await fetch(`${s.url}/v1/dev/identities`, { method: 'DELETE' })).status).toBe(200)
      const body = (await (await fetch(`${s.url}/v1/dev/identities`)).json()) as {
        credentials: string[]
      }
      expect(body.credentials).toEqual([])
    } finally {
      s.close()
    }
  })

  it('the dev routes DO NOT EXIST without dev mode', async () => {
    // An endpoint that can forget every credential must not be one flag away
    // in production, so it is absent rather than refused.
    const s = await listen(false)
    try {
      expect((await fetch(`${s.url}/v1/dev/identities`)).status).toBe(404)
      expect((await fetch(`${s.url}/v1/dev/identities`, { method: 'DELETE' })).status).toBe(404)
      const body = (await (await fetch(`${s.url}/v1/health`)).json()) as { routes: string[] }
      expect(body.routes.some((r) => r.includes('/v1/dev/'))).toBe(false)
    } finally {
      s.close()
    }
  })

  it('/v1/pay is not served, and never will be', async () => {
    const s = await listen(true)
    try {
      expect((await fetch(`${s.url}/v1/pay`, { method: 'POST' })).status).toBe(404)
    } finally {
      s.close()
    }
  })
})
