import { describe, expect, it } from 'vitest'
import { inviteRefusal, spacedCode, timeLeft, typedAddress, watchClaimed } from '../src/renderer/src/watch-code'

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

describe('the sheet that hands a watch its code', () => {
  it('says each refusal in words a person can act on', () => {
    expect(inviteRefusal('bad_credentials')).toBe("That password isn't right.")
    expect(inviteRefusal('not_sealed')).toContain('https')
    expect(inviteRefusal('provider_required')).toContain('on the Mac')
    expect(inviteRefusal('no_account')).toContain('Sign in')
    expect(inviteRefusal('something_new', 'The registry said so.')).toBe('The registry said so.')
    expect(inviteRefusal('something_new')).toBe("That didn't work. Try again.")
  })

  it('knows the code was taken: paired, nothing on offer, and time still left', () => {
    const at = 1000
    const until = 5000
    expect(watchClaimed({ paired: true, pending: null, account: 'password' }, until, at)).toBe(true)
    expect(watchClaimed({ paired: true, pending: { expiresAt: until }, account: 'password' }, until, at)).toBe(false)
    expect(watchClaimed({ paired: false, pending: null, account: 'password' }, until, at)).toBe(false)
    expect(watchClaimed({ paired: true, pending: null, account: 'password' }, until, until)).toBe(false)
  })
})
