import { describe, expect, it } from 'vitest'
import { decodeCbor, CBOR_MAX_DEPTH } from '../registry/src/v2-cbor'

/**
 * THE BOUNDED CBOR DECODER.
 *
 * It exists for exactly one input: an attestation object a browser hands us,
 * which is a stranger's bytes. So the tests are mostly about what it REFUSES —
 * a length that runs off the end, a nesting a recursive reader would blow the
 * stack on, an indefinite-length string that has no end to find, a tag it
 * would have to interpret. Anything it cannot read completely and finitely is
 * a refusal with a reason, never a partial value.
 */

const hex = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text.replace(/\s/g, ''), 'hex'))
const value = (text: string): unknown => {
  const out = decodeCbor(hex(text))
  if (!out.ok) throw new Error(`refused: ${out.reason}`)
  return out.value
}
const refusal = (text: string): string => {
  const out = decodeCbor(hex(text))
  return out.ok ? 'accepted' : out.reason
}

describe('cbor · the values an attestation is made of', () => {
  it('reads unsigned integers at every width (RFC 8949 appendix A)', () => {
    expect(value('00')).toBe(0)
    expect(value('17')).toBe(23)
    expect(value('1818')).toBe(24)
    expect(value('1903e8')).toBe(1000)
    expect(value('1a000f4240')).toBe(1000000)
  })

  it('reads negative integers — COSE labels are all negative', () => {
    expect(value('20')).toBe(-1)
    expect(value('29')).toBe(-10)
    expect(value('3863')).toBe(-100)
  })

  it('reads byte strings and text strings', () => {
    expect(Buffer.from(value('44 01020304') as Uint8Array).toString('hex')).toBe('01020304')
    expect(value('63 666d74')).toBe('fmt')
    expect(value('40')).toEqual(new Uint8Array(0))
    expect(value('60')).toBe('')
  })

  it('reads arrays and maps, and keeps a map as a Map so -1 and "-1" differ', () => {
    expect(value('83 010203')).toEqual([1, 2, 3])
    const map = value('a2 0101 2002') as Map<unknown, unknown>
    expect(map).toBeInstanceOf(Map)
    expect(map.get(1)).toBe(1)
    expect(map.get(-1)).toBe(2)
    expect(map.get('1')).toBeUndefined()
  })

  it('reads the three simple values it allows and nothing else', () => {
    expect(value('f4')).toBe(false)
    expect(value('f5')).toBe(true)
    expect(value('f6')).toBeNull()
    expect(refusal('f7')).toBe('unsupported_simple')
    expect(refusal('fb 3ff199999999999a')).toBe('unsupported_simple')
  })

  it('reads a nested attestation-shaped map', () => {
    // {"fmt": "none", "attStmt": {}, "authData": h'0102'}
    const out = value('a3 63666d74 646e6f6e65 6761747453746d74 a0 686175746844617461 420102') as Map<
      string,
      unknown
    >
    expect(out.get('fmt')).toBe('none')
    expect(out.get('attStmt')).toBeInstanceOf(Map)
  })
})

describe('cbor · what it refuses', () => {
  it('refuses truncation, at the head and in the middle', () => {
    expect(refusal('')).toBe('truncated')
    expect(refusal('18')).toBe('truncated')
    expect(refusal('44 010203')).toBe('truncated')
    expect(refusal('83 0102')).toBe('truncated')
    expect(refusal('a1 01')).toBe('truncated')
  })

  it('refuses a length that runs past the buffer instead of allocating it', () => {
    // A byte string claiming 4 GB, with nothing after it.
    expect(refusal('5a ffffffff')).toBe('truncated')
  })

  it('refuses indefinite lengths — there is no end to find', () => {
    expect(refusal('5f 42010243030405 ff')).toBe('indefinite')
    expect(refusal('9f 0102 ff')).toBe('indefinite')
    expect(refusal('bf 0101 ff')).toBe('indefinite')
  })

  it('refuses tags: an attestation object has none, so reading one is a guess', () => {
    expect(refusal('c0 63323032')).toBe('tag')
  })

  it('refuses nesting past its depth, without recursing to find out', () => {
    const deep = (levels: number): string => '81'.repeat(levels) + '00'
    expect(refusal(deep(CBOR_MAX_DEPTH - 1))).toBe('accepted')
    expect(refusal(deep(CBOR_MAX_DEPTH + 1))).toBe('too_deep')
    expect(refusal(deep(4000))).toBe('too_deep')
  })

  it('refuses an integer past what a number holds exactly', () => {
    expect(refusal('1b ffffffffffffffff')).toBe('too_large')
  })

  it('refuses a duplicate map key rather than picking one of the two', () => {
    expect(refusal('a2 0101 0102')).toBe('duplicate_key')
  })

  it('refuses a map key that is not an integer or a string', () => {
    expect(refusal('a1 8001 02')).toBe('bad_key')
  })

  it('refuses trailing bytes — an attestation object is one item', () => {
    expect(refusal('00 00')).toBe('trailing')
  })

  it('refuses more items than it will hold', () => {
    // An array header claiming a million items, in three bytes.
    expect(refusal('9a 000f4240')).toBe('too_many')
  })

  it('refuses text that is not utf-8', () => {
    expect(refusal('62 c328')).toBe('bad_text')
  })
})
