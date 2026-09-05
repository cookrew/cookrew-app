import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/shared/canonical-json'

describe('canonical json', () => {
  it('sorts keys at every depth and emits no whitespace', () => {
    const a = canonicalJson({ b: 1, a: { z: true, y: [3, 2] } })
    const b = canonicalJson({ a: { y: [3, 2], z: true }, b: 1 })
    expect(a).toBe('{"a":{"y":[3,2],"z":true},"b":1}')
    expect(a).toBe(b)
  })

  it('leaves array order alone, because order is the data', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]')
  })

  it('keeps an explicit null and drops an undefined member', () => {
    expect(canonicalJson({ tailnet: null, relay: false })).toBe('{"relay":false,"tailnet":null}')
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}')
  })

  it('escapes strings the way JSON does', () => {
    expect(canonicalJson({ 'a"b': 'x\ny' })).toBe('{"a\\"b":"x\\ny"}')
  })

  it('survives a reach-card round trip through parse', () => {
    const card = {
      deviceId: 'd1', relay: true, at: 1000,
      lan: [{ url: 'https://192.168.1.2:8643', certFp: 'ab' }],
      tailnet: { url: 'https://m.ts.net:8643', certFp: 'ab' }
    }
    expect(canonicalJson(JSON.parse(JSON.stringify(card)))).toBe(canonicalJson(card))
  })
})
