import { describe, expect, it } from 'vitest'
import { spacedCode, timeLeft, typedAddress } from '../src/renderer/src/watch-code'

describe('the digits on the Mac’s ⋯ row', () => {
  it('reads in two halves', () => expect(spacedCode('482193')).toBe('482 193'))
  it('the address is what a wrist types: the LAN first, the plain port left off', () => {
    expect(typedAddress([{ kind: 'name', url: 'https://a.d.cookrew.dev:8643' }, { kind: 'lan', url: 'http://192.168.2.40:8639' }])).toBe('192.168.2.40')
    expect(typedAddress([{ kind: 'tailnet', url: 'http://100.64.1.2:8639' }])).toBe('100.64.1.2')
    expect(typedAddress([{ kind: 'name', url: 'https://a.d.cookrew.dev:8643' }])).toBe('a.d.cookrew.dev:8643')
    expect(typedAddress([])).toBeNull()
  })
  it('counts down, and ends', () => {
    expect(timeLeft(61_000, 0)).toBe('1:01')
    expect(timeLeft(1000, 999)).toBe('0:01')
    expect(timeLeft(1000, 1000)).toBeNull()
  })
})
