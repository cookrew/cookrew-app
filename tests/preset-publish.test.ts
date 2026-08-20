import { describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { blobId, buildManifest, keyIdOf, signManifest, verifyManifest } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const keys = (): { publicKey: import('node:crypto').KeyObject; privateKey: import('node:crypto').KeyObject } =>
  generateKeyPairSync('ed25519')

const terminal = (over: Record<string, unknown> = {}): CanvasNode =>
  ({
    kind: 'terminal',
    id: 't1',
    name: 'Forge',
    preset: 'Claude Code',
    command: 'npm test',
    cwd: '/Users/drej/workspace/cookrew-dev',
    orch: false,
    role: 'Developer',
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 },
    ...over
  }) as CanvasNode

const snapshot = (nodes: CanvasNode[] = [terminal()]): TeamSnapshot => ({
  name: 'crew',
  savedAt: 1_700_000_000_000,
  dir: '/Users/drej/workspace/cookrew-dev',
  nodes,
  connections: [],
  turns: {}
})

const author = { handle: 'drej' }

describe('blobId — content addressing', () => {
  it('is a sha256 content address and is deterministic', () => {
    expect(blobId(Buffer.from('hello'))).toBe(blobId(Buffer.from('hello')))
    expect(blobId(Buffer.from('hello'))).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('changes with a single byte', () => {
    expect(blobId(Buffer.from('hello'))).not.toBe(blobId(Buffer.from('hellp')))
  })
})

describe('buildManifest — publish REFUSES on a dirty scrub', () => {
  it('will not build from a blocked scrub, and returns no manifest at all', () => {
    const dirty = scrubForPublish(snapshot([terminal({ command: 'export K=AKIAIOSFODNN7EXAMPLE' })]))
    expect(dirty.ok).toBe(false)
    const out = buildManifest({ scrub: dirty, version: 1, author })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toContain('secret')
    expect((out as { manifest?: unknown }).manifest).toBeUndefined()
  })

  it('builds from a clean scrub and content-addresses the team blob', () => {
    const clean = scrubForPublish(snapshot())
    const out = buildManifest({ scrub: clean, version: 1, author })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.manifest.schema).toBe('cookrew.preset/1')
    expect(out.manifest.blobs['team.json']).toBe(blobId(out.teamBytes))
    // The preset's id IS the content address of its team file.
    expect(out.manifest.id).toBe(out.manifest.blobs['team.json'])
  })

  it('carries the scrub report verbatim, so the review sheet reads signed data', () => {
    const clean = scrubForPublish(snapshot([terminal({ preset: 'Shell', command: 'make deploy' })]))
    const out = buildManifest({ scrub: clean, version: 1, author })
    if (!out.ok) throw new Error('refused')
    expect(out.manifest.scrub.commands).toBe(1)
    expect(out.manifest.scrub.secretScan).toBe('clean')
  })

  it('rejects a version that is not a positive integer', () => {
    const clean = scrubForPublish(snapshot())
    expect(buildManifest({ scrub: clean, version: 0, author }).ok).toBe(false)
    expect(buildManifest({ scrub: clean, version: 1.5, author }).ok).toBe(false)
  })
})

describe('signManifest / verifyManifest — the client verifies for itself', () => {
  const built = (): { manifest: import('../src/shared/preset-manifest').PresetManifest } => {
    const out = buildManifest({ scrub: scrubForPublish(snapshot()), version: 1, author })
    if (!out.ok) throw new Error('refused')
    return { manifest: out.manifest }
  }

  it('round-trips: a signed manifest verifies under the author key', () => {
    const { publicKey, privateKey } = keys()
    const signed = signManifest(built().manifest, privateKey)
    expect(signed.sig).toMatch(/^ed25519:/)
    expect(verifyManifest(signed, publicKey)).toBe(true)
  })

  it('fails when ANY signed field is tampered with', () => {
    const { publicKey, privateKey } = keys()
    const signed = signManifest(built().manifest, privateKey)
    for (const tamper of [
      { ...signed, version: 99 },
      { ...signed, id: 'sha256:' + 'f'.repeat(64) },
      { ...signed, blobs: { 'team.json': 'sha256:' + 'f'.repeat(64) } },
      { ...signed, scrub: { ...signed.scrub, secretScan: 'clean' as const, commands: 999 } }
    ]) {
      expect(verifyManifest(tamper, publicKey)).toBe(false)
    }
  })

  it('fails under a different key — a registry cannot re-sign', () => {
    const { privateKey } = keys()
    const other = keys()
    expect(verifyManifest(signManifest(built().manifest, privateKey), other.publicKey)).toBe(false)
  })

  it('fails when the keyId does not bind to the key that signed it', () => {
    // The manifest names its author; if a registry could swap the handle/keyId
    // while keeping a valid signature, attribution would be forgeable.
    const { publicKey, privateKey } = keys()
    const signed = signManifest(built().manifest, privateKey)
    const impersonated = { ...signed, author: { ...signed.author, keyId: 'ed25519:someoneelse' } }
    expect(verifyManifest(impersonated, publicKey)).toBe(false)
  })

  it('stamps the author keyId from the key itself, not from caller input', () => {
    const { publicKey, privateKey } = keys()
    const signed = signManifest(built().manifest, privateKey)
    expect(signed.author.keyId).toBe(keyIdOf(publicKey))
  })

  it('rejects a manifest with no signature rather than treating it as unsigned-ok', () => {
    const { publicKey } = keys()
    expect(verifyManifest(built().manifest, publicKey)).toBe(false)
  })

  it('rejects a malformed signature without throwing', () => {
    const { publicKey, privateKey } = keys()
    const signed = signManifest(built().manifest, privateKey)
    expect(verifyManifest({ ...signed, sig: 'ed25519:not-base64!!' }, publicKey)).toBe(false)
    expect(verifyManifest({ ...signed, sig: 'garbage' }, publicKey)).toBe(false)
  })
})
