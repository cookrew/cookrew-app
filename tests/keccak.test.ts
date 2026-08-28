import { describe, expect, it } from 'vitest'
import { keccak256Hex } from '../src/shared/keccak'

// VENDORED CRYPTO IS PINNED BY PUBLISHED VECTORS, or it is a guess with a
// confident name. These are the canonical Keccak-256 values — the ORIGINAL
// Keccak padding (0x01), which is what Ethereum uses, NOT the standardised
// SHA3-256 (0x06). The two differ in one byte and agree on nothing, so the
// empty-string vector alone catches the most likely implementation mistake.
//
// This exists because EIP-55 is a keccak256 encoding: without it an address
// cannot be checked at all, and the alternative on offer was format-only
// validation — which accepts a mistyped-but-well-formed address and sends an
// author's money somewhere unrecoverable.

describe('keccak256 — canonical vectors', () => {
  it('hashes the empty string', () => {
    // The single most useful vector: SHA3-256 of '' is a completely different
    // digest, so a padding mistake fails here immediately.
    expect(keccak256Hex(new Uint8Array())).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    )
  })

  it('hashes "abc"', () => {
    expect(keccak256Hex(new TextEncoder().encode('abc'))).toBe(
      '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'
    )
  })

  it('hashes the pangram', () => {
    expect(
      keccak256Hex(new TextEncoder().encode('The quick brown fox jumps over the lazy dog'))
    ).toBe('4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15')
  })

  it('hashes a message that spans exactly one rate block (136 bytes)', () => {
    // The block boundary is where a sponge implementation most often breaks:
    // padding must open a NEW block rather than overwrite the last byte.
    const exact = new Uint8Array(136).fill(0x61)
    expect(keccak256Hex(exact)).toHaveLength(64)
    // ...and it must differ from 135 and 137 bytes, which a boundary bug
    // would collide.
    expect(keccak256Hex(exact)).not.toBe(keccak256Hex(new Uint8Array(135).fill(0x61)))
    expect(keccak256Hex(exact)).not.toBe(keccak256Hex(new Uint8Array(137).fill(0x61)))
  })

  it('hashes a multi-block message', () => {
    const long = new Uint8Array(1000).fill(0x41)
    expect(keccak256Hex(long)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic and length-preserving', () => {
    const bytes = new TextEncoder().encode('cookrew')
    expect(keccak256Hex(bytes)).toBe(keccak256Hex(bytes))
    expect(keccak256Hex(bytes)).toHaveLength(64)
  })

  it('avalanches — one flipped bit changes the digest completely', () => {
    const a = keccak256Hex(new TextEncoder().encode('cookrew'))
    const b = keccak256Hex(new TextEncoder().encode('cookrex'))
    expect(a).not.toBe(b)
    const shared = [...a].filter((ch, i) => ch === b[i]).length
    expect(shared).toBeLessThan(32)
  })
})
