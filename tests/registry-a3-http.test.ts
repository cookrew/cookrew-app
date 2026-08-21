import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog, verifyChain, type LogRecord } from '../registry/src/log'
import { createRegistry } from '../registry/src/server'
import { IdentityService, type IdentityConfig } from '../registry/src/identity'
import { makeAuthorize } from '../registry/src/authorize'
import { countersignBinding } from '../registry/src/countersign'
import { buildManifest, keyIdOf, signManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

/**
 * A3 COMPLETED — PUBLISH AND ROTATION OVER HTTP.
 *
 * A3 shipped these as a library with no route, so "authenticated publish" was a
 * statement about functions rather than about a server. Everything here drives
 * the real routes, because that is the difference the review found.
 *
 * The centrepiece is `describe('the log is not a set of spare keys')`: the
 * countersignature is PUBLISHED, and until this slice it was a bare signature
 * over bytes that never said which operation was meant — so a value lifted from
 * the log was a working credential for the other one.
 */

const terminal = (command = 'npm test'): CanvasNode =>
  ({
    kind: 'terminal',
    id: 't1',
    name: 'Forge',
    preset: 'Claude Code',
    command,
    cwd: '/w',
    orch: false,
    role: null,
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 }
  }) as CanvasNode

const CONFIG: IdentityConfig = {
  rpId: 'localhost',
  origin: 'http://localhost:8790',
  tokenTtlMs: 10 * 60 * 1000,
  challengeTtlMs: 90 * 1000
}

const b64 = (b: Buffer): string => b.toString('base64url')

/** A software authenticator: the same shape a browser produces. */
function authenticator(credentialId: string) {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const authData = Buffer.concat([
    createHash('sha256').update(CONFIG.rpId).digest(),
    Buffer.from([0x01]),
    Buffer.from([0, 0, 0, 1])
  ])
  return {
    credentialId,
    jwk: keys.publicKey.export({ format: 'jwk' }) as Record<string, unknown>,
    assert(challenge: string) {
      const clientData = Buffer.from(
        JSON.stringify({ type: 'webauthn.get', origin: CONFIG.origin, challenge }),
        'utf8'
      )
      const signature = sign(
        'sha256',
        Buffer.concat([authData, createHash('sha256').update(clientData).digest()]),
        keys.privateKey
      )
      return {
        credentialId,
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(signature)
      }
    }
  }
}

function authored(name: string, version: number, key: KeyObject, command = 'npm test') {
  const snapshot: TeamSnapshot = {
    name,
    savedAt: 1,
    dir: '/w',
    nodes: [terminal(command)],
    connections: [],
    turns: {}
  }
  const built = buildManifest({ scrub: scrubForPublish(snapshot), version, author: { handle: 'drej' } })
  if (!built.ok) throw new Error(`refused: ${built.reason}`)
  return { manifest: signManifest(built.manifest, key), teamBytes: built.teamBytes }
}

let base = ''
let store: RegistryStore
let log: TransparencyLog
let identity: IdentityService
let author: { publicKey: KeyObject; privateKey: KeyObject }
let auth: ReturnType<typeof authenticator>
let server: { url: string; close: () => void }

const listen = async (withIdentity = true): Promise<{ url: string; close: () => void }> => {
  const s = createRegistry(
    withIdentity
      ? { store, log, identity, dev: true, authorize: makeAuthorize(store, identity) }
      : { store, log }
  )
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const { port } = s.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, close: () => s.close() }
}

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-a3-http-'))
  store = new RegistryStore(base)
  log = new TransparencyLog(base)
  identity = new IdentityService(base, CONFIG)
  author = generateKeyPairSync('ed25519')
  auth = authenticator('cred-drej')
  identity.register(auth.credentialId, auth.jwk)
  server = await listen()
})
afterEach(() => {
  server.close()
  rmSync(base, { recursive: true, force: true })
})

const post = (path: string, body: unknown, token?: string): Promise<Response> =>
  fetch(`${server.url}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` }
  })

const challengeOf = (res: Response): string =>
  (res.headers.get('www-authenticate') ?? '').split('challenge=')[1]

/** A publish-scoped token, through the real ceremony. */
async function publishToken(): Promise<string> {
  const first = await fetch(`${server.url}/v1/presets/x/manifest`)
  void first
  const challenge = identity.challenge()
  const minted = (await (
    await post('/v1/identity/assert', { ...auth.assert(challenge), scope: 'publish' })
  ).json()) as { token: string }
  return minted.token
}

async function downloadToken(): Promise<string> {
  const minted = (await (
    await post('/v1/identity/assert', { ...auth.assert(identity.challenge()), scope: 'download' })
  ).json()) as { token: string }
  return minted.token
}

/** Run the publish ceremony end to end and return the final response. */
async function publishOverHttp(
  m: { manifest: { id: string; author: { keyId: string } }; teamBytes: Buffer },
  name: string,
  token: string,
  visibility: 'public' | 'identified' = 'public'
): Promise<Response> {
  const body = {
    manifest: m.manifest,
    team: m.teamBytes.toString('base64'),
    teamName: name,
    visibility
  }
  // First attempt carries no countersignature: the server answers 401 with a
  // challenge bound to this exact operation, key and preset.
  const asked = await post('/v1/presets', body, token)
  expect(asked.status).toBe(401)
  const assertion = auth.assert(challengeOf(asked))
  return post('/v1/presets', { ...body, countersign: assertion }, token)
}

describe('POST /v1/presets — the write side exists', () => {
  it('publishes, and the preset is then servable and in the log', async () => {
    const m = authored('Deep Research', 1, author.privateKey)
    const res = await publishOverHttp(m, 'Deep Research', await publishToken())
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ id: m.manifest.id, version: 1 })

    const served = await fetch(`${server.url}/v1/presets/${encodeURIComponent(m.manifest.id)}/manifest`)
    expect(served.status).toBe(200)
    expect(await served.json()).toEqual(m.manifest)
    expect(log.all().map((r) => r.kind)).toEqual(['publish'])
    expect(verifyChain(log.all())).toBeNull()
  })

  it('asks for a ceremony PER MANIFEST — a second publish gets its own challenge', async () => {
    // Spec §6. The challenge is spent on use, so the same one cannot cover two.
    const token = await publishToken()
    const first = authored('Deep Research', 1, author.privateKey, 'a')
    const second = authored('Ship Crew', 1, author.privateKey, 'b')
    const a = await post('/v1/presets', {
      manifest: first.manifest, team: first.teamBytes.toString('base64'), teamName: 'Deep Research'
    }, token)
    const b = await post('/v1/presets', {
      manifest: second.manifest, team: second.teamBytes.toString('base64'), teamName: 'Ship Crew'
    }, token)
    expect(challengeOf(a)).not.toBe(challengeOf(b))
  })

  it('refuses an unauthenticated publish with a challenge, never a bare no', async () => {
    const m = authored('Deep Research', 1, author.privateKey)
    const res = await post('/v1/presets', {
      manifest: m.manifest, team: m.teamBytes.toString('base64'), teamName: 'Deep Research'
    })
    expect(res.status).toBe(401)
    expect(res.headers.get('www-authenticate')).toMatch(/^WebAuthn realm="market", challenge=/)
    expect(log.all()).toEqual([])
  })

  it('D4/R26 THE OTHER WAY: a download token at the publish route is 403 scope', async () => {
    // Until these routes existed only one direction of R26 was reachable, so
    // half the ruling was untested by construction.
    const m = authored('Deep Research', 1, author.privateKey)
    const res = await post('/v1/presets', {
      manifest: m.manifest, team: m.teamBytes.toString('base64'), teamName: 'Deep Research'
    }, await downloadToken())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ reason: 'scope' })
  })

  it('refuses bytes that are not what the manifest says they are', async () => {
    const m = authored('Deep Research', 1, author.privateKey)
    const other = authored('Deep Research', 1, author.privateKey, 'different')
    const token = await publishToken()
    const body = {
      manifest: m.manifest,
      team: other.teamBytes.toString('base64'),
      teamName: 'Deep Research'
    }
    const asked = await post('/v1/presets', body, token)
    const res = await post('/v1/presets', { ...body, countersign: auth.assert(challengeOf(asked)) }, token)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ reason: 'hash_mismatch' })
    expect(log.all()).toEqual([])
  })

  it('refuses a republished version, so "is there an update" stays answerable', async () => {
    const token = await publishToken()
    const v1 = authored('Audit Pack', 1, author.privateKey, 'a')
    expect((await publishOverHttp(v1, 'Audit Pack', token)).status).toBe(201)
    const same = authored('Audit Pack', 1, author.privateKey, 'b')
    const res = await publishOverHttp(same, 'Audit Pack', token)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ reason: 'version_not_newer' })
  })

  it('refuses a body too large to be a preset rather than reading it all', async () => {
    const token = await publishToken()
    const res = await post('/v1/presets', {
      manifest: { id: 'x', author: { keyId: 'y' } },
      team: 'A'.repeat(2 * 1024 * 1024),
      teamName: 'huge'
    }, token)
    expect(res.status).toBe(413)
  })

  it('does not exist at all when the deployment has no identity', async () => {
    server.close()
    server = await listen(false)
    const m = authored('Deep Research', 1, author.privateKey)
    const res = await post('/v1/presets', {
      manifest: m.manifest, team: m.teamBytes.toString('base64'), teamName: 'Deep Research'
    })
    expect(res.status).toBe(404)
  })
})

describe('POST /v1/presets/:id/rotate — R20 gets its registry half over the wire', () => {
  it('records a countersigned rotation the log then carries', async () => {
    const token = await publishToken()
    const v1 = authored('Audit Pack', 1, author.privateKey, 'a')
    expect((await publishOverHttp(v1, 'Audit Pack', token)).status).toBe(201)

    const newKey = generateKeyPairSync('ed25519')
    const newKeyId = keyIdOf(newKey.publicKey)
    const url = `/v1/presets/${encodeURIComponent(v1.manifest.id)}/rotate`
    const asked = await post(url, { newAuthorKeyId: newKeyId }, token)
    expect(asked.status).toBe(401)
    const res = await post(
      url,
      { newAuthorKeyId: newKeyId, countersign: auth.assert(challengeOf(asked)) },
      token
    )
    expect(res.status).toBe(200)
    expect(log.all().map((r) => r.kind)).toEqual(['publish', 'key-rotation'])
    expect(verifyChain(log.all())).toBeNull()
  })

  it('refuses a rotation from an identity that never held the preset', async () => {
    const token = await publishToken()
    const v1 = authored('Audit Pack', 1, author.privateKey, 'a')
    await publishOverHttp(v1, 'Audit Pack', token)

    // A second, fully enrolled identity — rotation must not be a way to TAKE a
    // lineage over, however good the intruder's own credentials are.
    const other = authenticator('cred-attacker')
    identity.register(other.credentialId, other.jwk)
    const otherToken = (
      (await (
        await post('/v1/identity/assert', {
          ...other.assert(identity.challenge()),
          scope: 'publish'
        })
      ).json()) as { token: string }
    ).token

    const newKeyId = keyIdOf(generateKeyPairSync('ed25519').publicKey)
    const url = `/v1/presets/${encodeURIComponent(v1.manifest.id)}/rotate`
    const asked = await post(url, { newAuthorKeyId: newKeyId }, otherToken)
    const res = await post(
      url,
      { newAuthorKeyId: newKeyId, countersign: other.assert(challengeOf(asked)) },
      otherToken
    )
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ reason: 'author_key_changed' })
    expect(log.all().map((r) => r.kind)).toEqual(['publish'])
  })

  it('refuses a key id that names no usable key', async () => {
    const token = await publishToken()
    const v1 = authored('Audit Pack', 1, author.privateKey, 'a')
    await publishOverHttp(v1, 'Audit Pack', token)
    const res = await post(
      `/v1/presets/${encodeURIComponent(v1.manifest.id)}/rotate`,
      { newAuthorKeyId: 'ed25519:not-a-key!!' },
      token
    )
    expect(res.status).toBe(400)
  })
})

describe('the log is not a set of spare keys', () => {
  /** Publish, then hand back the countersignature the log now carries. */
  async function publishAndHarvest(): Promise<{ presetId: string; record: LogRecord; token: string }> {
    const token = await publishToken()
    const v1 = authored('Audit Pack', 1, author.privateKey, 'a')
    expect((await publishOverHttp(v1, 'Audit Pack', token)).status).toBe(201)
    const record = log.all()[0]
    expect(typeof record.countersig).toBe('string')
    return { presetId: v1.manifest.id, record, token }
  }

  it('THE FIX: a countersignature read out of the log cannot be replayed as a rotation', async () => {
    // The attack this slice closes. Before it, publish and rotation shared one
    // payload — sha256(authorKeyId ‖ presetId) — verified as a bare signature.
    // The countersig is PUBLISHED in the log, so anyone with a session token
    // could lift it and turn a publish into a key rotation, which is the one
    // operation that moves who may sign a lineage.
    const { presetId, record, token } = await publishAndHarvest()

    const url = `/v1/presets/${encodeURIComponent(presetId)}/rotate`
    const asked = await post(url, { newAuthorKeyId: record.authorKeyId }, token)
    expect(asked.status).toBe(401)

    // Everything the old design checked, replayed verbatim: the same identity,
    // the same author key, the same preset, and the signature the log handed
    // over. It is refused because a rotation's payload is different bytes AND
    // because a bare signature is no longer a countersignature at all.
    const replayed = await post(
      url,
      {
        newAuthorKeyId: record.authorKeyId,
        countersign: {
          credentialId: auth.credentialId,
          clientDataJSON: Buffer.from(
            JSON.stringify({
              type: 'webauthn.get',
              origin: CONFIG.origin,
              challenge: challengeOf(asked)
            }),
            'utf8'
          ).toString('base64url'),
          authenticatorData: Buffer.concat([
            createHash('sha256').update(CONFIG.rpId).digest(),
            Buffer.from([0x01]),
            Buffer.from([0, 0, 0, 1])
          ]).toString('base64url'),
          signature: record.countersig as string
        }
      },
      token
    )
    expect(replayed.status).toBe(401)
    expect(log.all().map((r) => r.kind)).toEqual(['publish'])
  })

  it('the two operations no longer agree about what was signed', () => {
    // The root cause, stated as an assertion: one payload for two meanings.
    const key = 'ed25519:abc'
    const preset = `sha256:${'a'.repeat(64)}`
    expect(countersignBinding('publish', key, preset)).not.toBe(
      countersignBinding('key-rotation', key, preset)
    )
  })

  it('a challenge is spent on first use, so even a correct assertion is single-shot', async () => {
    const token = await publishToken()
    const m = authored('Deep Research', 1, author.privateKey)
    const body = {
      manifest: m.manifest,
      team: m.teamBytes.toString('base64'),
      teamName: 'Deep Research'
    }
    const asked = await post('/v1/presets', body, token)
    const assertion = auth.assert(challengeOf(asked))
    expect((await post('/v1/presets', { ...body, countersign: assertion }, token)).status).toBe(201)
    // The very same assertion, replayed at the very same route.
    const again = await post('/v1/presets', { ...body, countersign: assertion }, token)
    expect(again.status).toBe(401)
    expect(log.all()).toHaveLength(1)
  })

  it('a LOGIN nonce cannot be spent as a countersignature, or the reverse', async () => {
    const token = await publishToken()
    const m = authored('Deep Research', 1, author.privateKey)
    // A challenge minted for the login ceremony, used to countersign a publish.
    const loginNonce = identity.challenge()
    const res = await post('/v1/presets', {
      manifest: m.manifest,
      team: m.teamBytes.toString('base64'),
      teamName: 'Deep Research',
      countersign: auth.assert(loginNonce)
    }, token)
    expect(res.status).toBe(401)

    // And the reverse: a countersign nonce spent as a login.
    const countersignNonce = identity.countersignChallenge(
      countersignBinding('publish', m.manifest.author.keyId, m.manifest.id)
    )
    const minted = await post('/v1/identity/assert', {
      ...auth.assert(countersignNonce),
      scope: 'publish'
    })
    expect(minted.status).toBe(401)
  })

  it('a countersignature from ANOTHER identity does not publish for this one', async () => {
    // Otherwise the log would record the caller's identity beside a ceremony
    // they never performed, and the log's one job is that its records are true.
    const token = await publishToken()
    const other = authenticator('cred-other')
    identity.register(other.credentialId, other.jwk)
    const m = authored('Deep Research', 1, author.privateKey)
    const body = {
      manifest: m.manifest,
      team: m.teamBytes.toString('base64'),
      teamName: 'Deep Research'
    }
    const asked = await post('/v1/presets', body, token)
    const res = await post(
      '/v1/presets',
      { ...body, countersign: other.assert(challengeOf(asked)) },
      token
    )
    expect(res.status).toBe(401)
    expect(log.all()).toEqual([])
  })
})

describe('/v1/health tells the truth in both directions', () => {
  it('lists the write routes when they are mounted', async () => {
    const body = (await (await fetch(`${server.url}/v1/health`)).json()) as { routes: string[] }
    expect(body.routes).toContain('POST /v1/presets')
    expect(body.routes).toContain('POST /v1/presets/:id/rotate')
  })

  it('does not list them when there is no identity — and they really are absent', async () => {
    server.close()
    server = await listen(false)
    const body = (await (await fetch(`${server.url}/v1/health`)).json()) as { routes: string[] }
    expect(body.routes).not.toContain('POST /v1/presets')
    expect(body.routes).not.toContain('POST /v1/presets/:id/rotate')
    expect(body.routes.some((r) => r.includes('/v1/identity/'))).toBe(false)
    // The list and the server agree — that is the property, not the list.
    expect((await post('/v1/presets', {})).status).toBe(404)
    expect((await post(`/v1/presets/sha256:${'a'.repeat(64)}/rotate`, {})).status).toBe(404)
    expect((await post('/v1/identity/assert', {})).status).toBe(404)
  })
})
