import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { downloadForReview } from '../src/main/preset-install-flow'
import { verifyPreset, reviewSheetPayload } from '../src/main/preset-install'
import { buildManifest, signManifest, publicKeyFromId } from '../src/main/preset-publish'
import { scrubForPublish } from '../src/main/preset-scrub'
import type { GateStep } from '../src/main/preset-download'
import type { TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

/**
 * Slice 2 — the download→verify→review flow, tested against a REAL signed
 * preset. Only the transport is stubbed; the crypto, verifier, and review
 * builder are the production ones, so this proves the composition the app runs,
 * not a mock of it. The gate branches (enrol/pay/denied/gone) are driven by
 * making the stubbed fetch return that step.
 */

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

const snapshot = (): TeamSnapshot =>
  ({ name: 'Reviewers', nodes: [terminal()], cables: [], dirs: [] }) as unknown as TeamSnapshot

/** A genuine signed preset: manifest + the exact team.json bytes + author key. */
function makePreset(): { manifest: ReturnType<typeof signManifest>; teamBytes: Buffer; key: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const scrub = scrubForPublish(snapshot())
  if (!scrub.ok) throw new Error('fixture scrub blocked')
  const built = buildManifest({ scrub, version: 1, author: { handle: 'drej' } })
  if (!built.ok) throw new Error('fixture manifest failed')
  const manifest = signManifest(built.manifest, privateKey)
  return { manifest, teamBytes: built.teamBytes, key: publicKey }
}

/** Deps whose transport serves a fixed manifest step and blob step. */
function deps(over: {
  manifestStep: GateStep
  blobStep?: GateStep
  trustedKeyFor?: (id: string) => KeyObject | null
}) {
  return {
    registryBase: 'https://mkt.example',
    fetchManifest: async (): Promise<GateStep> => over.manifestStep,
    fetchBlob: async (): Promise<GateStep> => over.blobStep ?? { kind: 'gone' },
    trustedKeyFor: over.trustedKeyFor ?? ((): KeyObject | null => null),
    verify: verifyPreset,
    review: reviewSheetPayload,
    claimedKey: (keyId: string): KeyObject | null => {
      try {
        return publicKeyFromId(keyId)
      } catch {
        return null
      }
    }
  }
}

describe('downloadForReview — the happy path', () => {
  it('a valid preset resolves to a review payload the sheet can render', async () => {
    const { manifest, teamBytes } = makePreset()
    const outcome = await downloadForReview(manifest.id, deps({
      manifestStep: { kind: 'ready', body: manifest },
      blobStep: { kind: 'ready', body: teamBytes }
    }))
    expect(outcome.kind).toBe('review')
    if (outcome.kind !== 'review') return
    expect(outcome.payload.id).toBe(manifest.id)
    expect(outcome.payload.author.handle).toBe('drej')
    expect(outcome.verified.snapshot.name).toBe('Reviewers')
  })
})

describe('downloadForReview — the gate branches surface verbatim', () => {
  it('401 → enrol', async () => {
    const outcome = await downloadForReview('sha256:aa', deps({
      manifestStep: { kind: 'enrol', challenge: 'c1' }
    }))
    expect(outcome).toEqual({ kind: 'enrol', challenge: 'c1' })
  })

  it('402 → pay, with the terms carried through', async () => {
    const terms = { amount: '2', asset: 'USDC' as const, chain: 'base', payTo: '0xabc', nonce: 'n', expiry: 1 }
    const outcome = await downloadForReview('sha256:aa', deps({
      manifestStep: { kind: 'pay', terms, retryable: false }
    }))
    expect(outcome).toEqual({ kind: 'pay', terms, retryable: false })
  })

  it('403 → denied', async () => {
    const outcome = await downloadForReview('sha256:aa', deps({
      manifestStep: { kind: 'denied', reason: 'revoked', retryable: false }
    }))
    expect(outcome).toEqual({ kind: 'denied', reason: 'revoked', retryable: false })
  })

  it('404 → gone', async () => {
    const outcome = await downloadForReview('sha256:aa', deps({
      manifestStep: { kind: 'gone' }
    }))
    expect(outcome).toEqual({ kind: 'gone' })
  })

  it('a gated BLOB (401) surfaces as enrol even though the manifest was free', async () => {
    const { manifest } = makePreset()
    const outcome = await downloadForReview(manifest.id, deps({
      manifestStep: { kind: 'ready', body: manifest },
      blobStep: { kind: 'enrol', challenge: 'c2' }
    }))
    expect(outcome).toEqual({ kind: 'enrol', challenge: 'c2' })
  })
})

describe('downloadForReview — verification is done by the client, closed on failure', () => {
  it('tampered team bytes → verify_failed(hash_mismatch), never a review', async () => {
    const { manifest } = makePreset()
    const outcome = await downloadForReview(manifest.id, deps({
      manifestStep: { kind: 'ready', body: manifest },
      blobStep: { kind: 'ready', body: Buffer.from('{"name":"Evil","nodes":[]}') }
    }))
    expect(outcome).toEqual({ kind: 'verify_failed', reason: 'hash_mismatch' })
  })

  it('a manifest whose id is not the one we asked for → verify_failed(hash_mismatch)', async () => {
    const { manifest, teamBytes } = makePreset()
    const outcome = await downloadForReview('sha256:' + 'f'.repeat(64), deps({
      manifestStep: { kind: 'ready', body: manifest },
      blobStep: { kind: 'ready', body: teamBytes }
    }))
    expect(outcome).toEqual({ kind: 'verify_failed', reason: 'hash_mismatch' })
  })

  it('a preset signed by a key other than the pinned one → verify_failed(author_key_changed)', async () => {
    const { manifest, teamBytes } = makePreset()
    const other = generateKeyPairSync('ed25519').publicKey
    const outcome = await downloadForReview(manifest.id, deps({
      manifestStep: { kind: 'ready', body: manifest },
      blobStep: { kind: 'ready', body: teamBytes },
      trustedKeyFor: () => other
    }))
    expect(outcome).toEqual({ kind: 'verify_failed', reason: 'author_key_changed' })
  })

  it('a non-object manifest body → error, not a crash', async () => {
    const outcome = await downloadForReview('sha256:aa', deps({
      manifestStep: { kind: 'ready', body: 'not a manifest' }
    }))
    expect(outcome.kind).toBe('error')
  })
})
