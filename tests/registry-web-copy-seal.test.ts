import { describe, expect, it } from 'vitest'
import { V3_COPY } from '../src/shared/account-copy'
import { WEB_V3_COPY, webCopy } from '../registry/src/v3-copy'

/**
 * THE WEB'S SENTENCES MATCH THE APP'S — byte for byte.
 *
 * The registry builds and ships separately and cannot import from src/shared,
 * so registry/src/v3-copy.ts writes the sentences out again by hand. The only
 * thing that makes that safe is this test, which is the same arrangement
 * registry-web-seal.test.ts uses for seal.js against relay-seal.ts: two
 * implementations, one contract, and a test standing between them.
 *
 * A person who reads one sentence on their Mac and a different one on their
 * phone learns that one of the two is lying to them. This is what stops that.
 */
describe('the registry mirror equals the shared source', () => {
  it('matches every mirrored key, character for character', () => {
    for (const [id, value] of Object.entries(WEB_V3_COPY)) {
      expect(V3_COPY[id as keyof typeof V3_COPY], id).toBe(value)
    }
  })

  it('mirrors only keys that exist in the source', () => {
    for (const id of Object.keys(WEB_V3_COPY)) {
      expect(Object.keys(V3_COPY), id).toContain(id)
    }
  })

  it('fills placeholders the same way, and throws the same way', () => {
    expect(webCopy('d11.seat-row', { handle: 'jkim', team: 'RESEARCH CREW' })).toBe(
      '@jkim asks for a seat at RESEARCH CREW.'
    )
    expect(() => webCopy('d12.revoke', {})).toThrow()
  })

  it('carries no sentence the web never draws', () => {
    // A duplicate that nothing renders is drift waiting for a reader.
    expect(Object.keys(WEB_V3_COPY).length).toBeLessThan(Object.keys(V3_COPY).length)
  })
})
