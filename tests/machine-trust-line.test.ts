import { describe, expect, it } from 'vitest'
import { blockedByTrust, machineTrustLine, TRUST_BUTTON } from '../src/renderer/src/zoom/machine-trust'

describe('the one line that lets this machine see the account’s others', () => {
  it('says nothing when this machine is trusted, when it is not known yet, or when no machine is waiting on it', () => {
    expect(machineTrustLine({ trusted: false }, 0, 'darwin')).toBeNull()
    expect(machineTrustLine({ trusted: true }, 2, 'darwin')).toBeNull()
    // Not asked yet is not "no": a Mac signed in a minute ago was told to sign in again (owner 2026-11-11).
    expect(machineTrustLine(null, 2, 'darwin')).toBeNull()
  })

  it('otherwise one button that says what it asks, and how: the proof, not another sign-in', () => {
    const mac = machineTrustLine({ trusted: false }, 1, 'darwin')
    expect(mac).toEqual({
      kind: 'button',
      text: 'Prove it’s you on this Mac to see your other machines',
      how: 'Your account password or a passkey, in the browser. The sign-in on this Mac did not include one: Google, GitHub or a code alone does not.'
    })
    expect(mac?.text).not.toMatch(/again/)
    const box = machineTrustLine({ trusted: false }, 1, 'linux')
    expect(box?.text).toBe('Prove it’s you on this machine to see your other machines')
    expect(box?.how).toContain('The sign-in on this machine did not include one')
    expect(TRUST_BUTTON).toBe('Prove it’s you on this Mac to see your other machines')
  })
})

describe('which machines the proof would open', () => {
  const machine = (over: object) => ({ local: false, online: true, detail: 'listed' as const, ...over })

  it('another machine that is online and not read: pressing would open it', () => {
    expect(blockedByTrust([machine({ local: true, detail: 'live' }), machine({})])).toBe(1)
  })

  it('not a machine that is off, signed out or already read: pressing would open nothing', () => {
    expect(blockedByTrust([machine({ local: true }), machine({ online: false }), machine({ detail: 'live' })])).toBe(0)
    expect(blockedByTrust([])).toBe(0)
  })
})
