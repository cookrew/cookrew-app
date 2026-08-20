import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { RegistryStore } from '../registry/src/store'
import { TransparencyLog, verifyChain } from '../registry/src/log'
import {
  countersignPayload,
  publishPreset,
  rotateAuthorKey,
  type PublishDeps
} from '../registry/src/publish'
import { buildManifest, signManifest, verifyManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import {
  FORBIDDEN_REASONS,
  isForbiddenReason,
  shouldRetrySilently,
  type PresetManifest
} from '../src/shared/preset-manifest'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const terminal = (command = 'npm test'): CanvasNode =>
  ({
    kind: 'terminal', id: 't1', name: 'Forge', preset: 'Claude Code', command,
    cwd: '/w', orch: false, role: null, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }
  }) as CanvasNode

function authored(name: string, version: number, key: KeyObject, command = 'npm test') {
  const snapshot: TeamSnapshot = {
    name, savedAt: 1, dir: '/w', nodes: [terminal(command)], connections: [], turns: {}
  }
  const built = buildManifest({ scrub: scrubForPublish(snapshot), version, author: { handle: 'drej' } })
  if (!built.ok) throw new Error(`refused: ${built.reason}`)
  return { manifest: signManifest(built.manifest, key), teamBytes: built.teamBytes }
}

let base = ''
let store: RegistryStore
let log: TransparencyLog
let author: { publicKey: KeyObject; privateKey: KeyObject }
/** Countersignatures are asserted by an identity; the shape is what matters. */
const countersigned = new Map<string, string>()
let deps: PublishDeps

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), 'registry-a3-'))
  store = new RegistryStore(base)
  log = new TransparencyLog(base)
  author = generateKeyPairSync('ed25519')
  countersigned.clear()
  deps = {
    store,
    log,
    verifyManifest: (m) => verifyManifest(m, author.publicKey),
    verifyCountersign: (identityId, payload, countersig) =>
      countersigned.get(`${identityId}:${payload.toString('hex')}`) === countersig
  }
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** Register a valid countersignature for an identity over a key+preset pair. */
function counterSign(identityId: string, authorKeyId: string, presetId: string): string {
  const payload = countersignPayload(authorKeyId, presetId)
  const value = `sig-${identityId}-${presetId.slice(-8)}`
  countersigned.set(`${identityId}:${payload.toString('hex')}`, value)
  return value
}

const publish = (
  m: { manifest: PresetManifest; teamBytes: Buffer },
  name: string,
  identityId = 'webauthn:drej',
  countersig?: string
) =>
  publishPreset(deps, {
    manifest: m.manifest,
    teamBytes: m.teamBytes,
    teamName: name,
    visibility: 'public',
    identityId,
    countersig: countersig ?? counterSign(identityId, m.manifest.author.keyId, m.manifest.id),
    at: 1
  })

describe('publish — three independent claims, all required', () => {
  it('accepts a signed manifest with a matching blob and a countersignature', () => {
    const out = publish(authored('Deep Research', 1, author.privateKey), 'Deep Research')
    expect(out.ok).toBe(true)
    expect(store.list()).toHaveLength(1)
  })

  it('refuses when the blob does not hash to the id the manifest claims', () => {
    const m = authored('Deep Research', 1, author.privateKey)
    const out = publish({ ...m, teamBytes: Buffer.from('{"tampered":true}') }, 'Deep Research')
    expect(out).toEqual({ ok: false, reason: 'hash_mismatch' })
    expect(store.list()).toEqual([])
  })

  it('refuses an unsigned manifest', () => {
    const m = authored('Deep Research', 1, author.privateKey)
    const out = publish({ ...m, manifest: { ...m.manifest, sig: undefined } }, 'Deep Research')
    expect(out).toEqual({ ok: false, reason: 'unsigned' })
  })

  it('refuses a manifest signed by a key the registry cannot verify', () => {
    const other = generateKeyPairSync('ed25519')
    const out = publish(authored('Deep Research', 1, other.privateKey), 'Deep Research')
    expect(out).toEqual({ ok: false, reason: 'signature_invalid' })
  })

  it('refuses a valid signature with NO countersignature — anonymous work', () => {
    const m = authored('Deep Research', 1, author.privateKey)
    const out = publish(m, 'Deep Research', 'webauthn:drej', 'not-a-countersig')
    expect(out).toEqual({ ok: false, reason: 'countersign_missing' })
  })

  it('refuses a countersignature made by a DIFFERENT identity', () => {
    const m = authored('Deep Research', 1, author.privateKey)
    const sig = counterSign('webauthn:someone-else', m.manifest.author.keyId, m.manifest.id)
    const out = publish(m, 'Deep Research', 'webauthn:drej', sig)
    expect(out).toEqual({ ok: false, reason: 'countersign_missing' })
  })

  it('binds the countersignature to BOTH the key and the preset', () => {
    // A signature over the key alone would be replayable onto any preset.
    const first = authored('Deep Research', 1, author.privateKey)
    const second = authored('Ship Crew', 1, author.privateKey, 'make build')
    const sigForFirst = counterSign('webauthn:drej', first.manifest.author.keyId, first.manifest.id)
    const out = publish(second, 'Ship Crew', 'webauthn:drej', sigForFirst)
    expect(out).toEqual({ ok: false, reason: 'countersign_missing' })
  })
})

describe('publish — TOFU across versions', () => {
  it('accepts a later version under the SAME author key', () => {
    expect(publish(authored('Audit Pack', 1, author.privateKey, 'a'), 'Audit Pack').ok).toBe(true)
    expect(publish(authored('Audit Pack', 2, author.privateKey, 'b'), 'Audit Pack').ok).toBe(true)
  })

  it('REFUSES a later version under a different key with no rotation', () => {
    expect(publish(authored('Audit Pack', 1, author.privateKey, 'a'), 'Audit Pack').ok).toBe(true)
    const attacker = generateKeyPairSync('ed25519')
    deps.verifyManifest = (m) =>
      verifyManifest(m, author.publicKey) || verifyManifest(m, attacker.publicKey)
    const out = publish(authored('Audit Pack', 2, attacker.privateKey, 'b'), 'Audit Pack')
    expect(out).toEqual({ ok: false, reason: 'author_key_changed' })
  })

  it('accepts the new key AFTER a countersigned rotation', () => {
    const v1 = authored('Audit Pack', 1, author.privateKey, 'a')
    expect(publish(v1, 'Audit Pack').ok).toBe(true)

    const attacker = generateKeyPairSync('ed25519')
    const v2 = authored('Audit Pack', 2, attacker.privateKey, 'b')
    deps.verifyManifest = (m) =>
      verifyManifest(m, author.publicKey) || verifyManifest(m, attacker.publicKey)

    const sig = counterSign('webauthn:drej', v2.manifest.author.keyId, v1.manifest.id)
    expect(
      rotateAuthorKey(deps, {
        lineage: 'x',
        presetId: v1.manifest.id,
        newAuthorKeyId: v2.manifest.author.keyId,
        identityId: 'webauthn:drej',
        countersig: sig,
        at: 2
      })
    ).toEqual({ ok: true })
  })

  it('refuses a rotation from an identity that never held the lineage', () => {
    const v1 = authored('Audit Pack', 1, author.privateKey, 'a')
    expect(publish(v1, 'Audit Pack').ok).toBe(true)
    // Rotation must not be a way to TAKE a lineage over.
    const out = rotateAuthorKey(deps, {
      lineage: 'x',
      presetId: v1.manifest.id,
      newAuthorKeyId: 'ed25519:attacker',
      identityId: 'webauthn:attacker',
      countersig: 'whatever',
      at: 2
    })
    expect(out).toEqual({ ok: false, reason: 'author_key_changed' })
  })

  it('refuses a version that is not newer, so "is there an update" stays answerable', () => {
    expect(publish(authored('Audit Pack', 2, author.privateKey, 'a'), 'Audit Pack').ok).toBe(true)
    const out = publish(authored('Audit Pack', 2, author.privateKey, 'c'), 'Audit Pack')
    expect(out).toEqual({ ok: false, reason: 'version_not_newer' })
  })
})

describe('publish — the log records what happened', () => {
  it('writes a chained publish record carrying the countersignature', () => {
    const m = authored('Deep Research', 1, author.privateKey)
    publish(m, 'Deep Research')
    const [record] = log.all()
    expect(record).toMatchObject({
      kind: 'publish',
      presetId: m.manifest.id,
      version: 1,
      authorKeyId: m.manifest.author.keyId,
      identityId: 'webauthn:drej'
    })
    expect(typeof record.countersig).toBe('string')
    expect(verifyChain(log.all())).toBeNull()
  })

  it('writes NOTHING when a publish is refused', () => {
    const m = authored('Deep Research', 1, author.privateKey)
    publish(m, 'Deep Research', 'webauthn:drej', 'bad')
    expect(log.all()).toEqual([])
    expect(store.list()).toEqual([])
  })

  it('keeps the chain intact across a publish and a rotation', () => {
    const v1 = authored('Audit Pack', 1, author.privateKey, 'a')
    publish(v1, 'Audit Pack')
    const sig = counterSign('webauthn:drej', 'ed25519:new', v1.manifest.id)
    rotateAuthorKey(deps, {
      lineage: 'x',
      presetId: v1.manifest.id,
      newAuthorKeyId: 'ed25519:new',
      identityId: 'webauthn:drej',
      countersig: sig,
      at: 2
    })
    expect(log.all().map((r) => r.kind)).toEqual(['publish', 'key-rotation'])
    expect(verifyChain(log.all())).toBeNull()
  })
})

describe('R26 — scope is the seventh 403, and the only one a client can fix', () => {
  it('joins the vocabulary', () => {
    expect([...FORBIDDEN_REASONS].sort()).toEqual(
      ['balance_empty', 'refunded', 'region', 'revoked', 'scope', 'seat_limit', 'version_gate'].sort()
    )
    expect(isForbiddenReason('scope')).toBe(true)
  })

  it('is retried SILENTLY once — the remedy is a re-ceremony, not a person', () => {
    expect(shouldRetrySilently('scope', 0)).toBe(true)
  })

  it('is NOT retried twice — a second refusal is a real disagreement', () => {
    // Retrying past this is the D4 loop with an extra ceremony per turn.
    expect(shouldRetrySilently('scope', 1)).toBe(false)
    expect(shouldRetrySilently('scope', 5)).toBe(false)
  })

  it('never silently retries a reason that needs a human', () => {
    for (const reason of ['seat_limit', 'balance_empty', 'revoked', 'refunded', 'region', 'version_gate'] as const) {
      expect(shouldRetrySilently(reason, 0)).toBe(false)
    }
  })
})
