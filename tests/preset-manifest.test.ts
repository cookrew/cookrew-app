import { describe, expect, it } from 'vitest'
import {
  PRESET_SCHEMA,
  PRESET_VERSION_HEADER,
  canonicalJson,
  signedPayload,
  updateAvailable,
  FORBIDDEN_REASONS,
  isForbiddenReason,
  isCallPathAnswer,
  type PresetManifest
} from '../src/shared/preset-manifest'

const manifest = (over: Partial<PresetManifest> = {}): PresetManifest => ({
  schema: PRESET_SCHEMA,
  id: 'sha256:aaaa',
  version: 3,
  team: 'team.json',
  blobs: { 'team.json': 'sha256:aaaa' },
  author: { keyId: 'ed25519:kkkk', handle: 'drej' },
  scrub: {
    sessions: false,
    paths: 'placeholders',
    commands: 1,
    notes: 2,
    urls: 0,
    secretScan: 'clean',
    findings: []
  },
  ...over
})

describe('canonicalJson — one manifest has exactly one signable form', () => {
  it('is insensitive to key insertion order', () => {
    // Two objects that are equal but built differently must sign identically,
    // or a round-trip through any JSON layer invalidates the signature.
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  })

  it('sorts nested keys, not just the top level', () => {
    expect(canonicalJson({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}')
  })

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}')
  })

  it('drops undefined members rather than emitting them', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })
})

describe('signedPayload — the signature covers everything except itself', () => {
  it('excludes sig', () => {
    const signed = signedPayload(manifest({ sig: 'ed25519:zzzz' }))
    expect(signed).not.toContain('zzzz')
    expect(signed).toBe(signedPayload(manifest()))
  })

  it('covers the scrub report, so a tampered report breaks the signature', () => {
    const a = signedPayload(manifest())
    const b = signedPayload(
      manifest({
        scrub: {
          sessions: true,
          paths: 'placeholders',
          commands: 1,
          notes: 2,
          urls: 0,
          secretScan: 'clean',
          findings: []
        }
      })
    )
    expect(a).not.toBe(b)
  })

  it('covers the blob hashes, so a swapped blob breaks the signature', () => {
    expect(signedPayload(manifest())).not.toBe(
      signedPayload(manifest({ blobs: { 'team.json': 'sha256:bbbb' } }))
    )
  })
})

describe('updateAvailable — R3: a HEAD by version is the whole request', () => {
  it('offers an update only when the registry is ahead', () => {
    expect(updateAvailable(2, 3)).toBe(true)
    expect(updateAvailable(3, 3)).toBe(false)
  })

  it('never offers a downgrade when the registry is behind or unknown', () => {
    expect(updateAvailable(3, 2)).toBe(false)
    expect(updateAvailable(3, null)).toBe(false)
  })

  it('names the header the HEAD answer carries', () => {
    expect(PRESET_VERSION_HEADER).toBe('x-cookrew-preset-version')
  })
})

describe('403 vocabulary — R11 adds balance_empty, R26 adds scope', () => {
  it('carries the spec five plus balance_empty and scope', () => {
    expect([...FORBIDDEN_REASONS].sort()).toEqual(
      ['balance_empty', 'refunded', 'region', 'revoked', 'scope', 'seat_limit', 'version_gate'].sort()
    )
  })

  it('guards unknown reasons instead of trusting the wire', () => {
    expect(isForbiddenReason('balance_empty')).toBe(true)
    expect(isForbiddenReason('teapot')).toBe(false)
    expect(isForbiddenReason('')).toBe(false)
  })
})

describe('isCallPathAnswer — R5: the call path answers 200 or 403, never 402', () => {
  it('accepts exactly 200 and 403', () => {
    expect(isCallPathAnswer(200)).toBe(true)
    expect(isCallPathAnswer(403)).toBe(true)
  })

  it('rejects 402 — payment never interrupts a conversation', () => {
    // Pay-per-call is a prepaid balance bought at install/top-up; an empty
    // balance is a 403 with reason balance_empty, not a wallet sheet mid-turn.
    expect(isCallPathAnswer(402)).toBe(false)
  })

  it('rejects 401 too — identity is settled before the call, not during it', () => {
    expect(isCallPathAnswer(401)).toBe(false)
  })
})
