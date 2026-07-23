import { describe, expect, it } from 'vitest'
import { originAllowed } from '../src/main/browser-cast'

describe('originAllowed (CSWSH / DNS-rebinding guard)', () => {
  it('allows no Origin (native / CLI client)', () => {
    expect(originAllowed({ headers: { host: '192.168.2.13:8643' } })).toBe(true)
  })
  it('allows a same-host Origin (the served phone bundle)', () => {
    expect(
      originAllowed({ headers: { origin: 'https://192.168.2.13:8643', host: '192.168.2.13:8643' } })
    ).toBe(true)
  })
  it('refuses a cross-origin web page', () => {
    expect(
      originAllowed({ headers: { origin: 'https://evil.example', host: '192.168.2.13:8643' } })
    ).toBe(false)
  })
  it('refuses a malformed Origin', () => {
    expect(originAllowed({ headers: { origin: 'not a url', host: '192.168.2.13:8643' } })).toBe(false)
  })
})
