import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReauthAccountEntry, refusalLine } from '../src/renderer/src/ReauthAccountEntry'
import type { PairClientDeps } from '../src/renderer/src/account-pair-client'

/**
 * THE ACCOUNT'S WAY IN, AS THE PHONE DRAWS IT (owner 2026-11-09).
 *
 * The card on a machine of the account: a passkey first, the account password
 * beside its button, in the machine's own word. Static markup is the picture.
 */

const deps = (passkey: boolean): PairClientDeps => ({
  get: async () => ({ status: 200, body: null }),
  post: async () => ({ status: 200, body: null }),
  device: async () => null,
  passkey: passkey ? async () => null : null
})

const draw = (platform: string, methods: ('password' | 'passkey')[], passkey = true): string =>
  renderToStaticMarkup(
    <ReauthAccountEntry
      offer={{ offered: true, desktopId: 'd', platform, methods }}
      deps={deps(passkey)}
      handle="anvztor"
      onEntered={async () => undefined}
    />
  )

describe('the account entry on the Not paired card', () => {
  it('leads with a passkey and offers the account password beside it, on Linux as "this machine"', () => {
    const markup = draw('linux', ['password', 'passkey'])
    expect(markup).toContain('Enter this machine with your account')
    expect(markup).not.toMatch(/\bMac\b/)
    expect(markup.indexOf('Use a passkey')).toBeLessThan(markup.indexOf('Account password'))
    // A password manager can fill it: a username beside a current-password field.
    expect(markup).toContain('autoComplete="current-password"')
    expect(markup).toContain('autoComplete="username"')
    expect(markup).toContain('value="anvztor"')
    expect(markup).toContain('>Enter</button>')
  })

  it('says Mac on a Mac', () => {
    expect(draw('darwin', ['password'])).toContain('Enter this Mac with your account')
  })

  it('draws no passkey button where the browser or the account has none', () => {
    expect(draw('linux', ['password'], true)).not.toContain('Use a passkey')
    expect(draw('linux', ['password', 'passkey'], false)).not.toContain('Use a passkey')
  })

  it('draws no password field for an account with only passkeys', () => {
    const markup = draw('linux', ['passkey'])
    expect(markup).toContain('Use a passkey')
    expect(markup).not.toContain('current-password')
  })

  it('says how many tries are left, and when to come back', () => {
    expect(refusalLine({ kind: 'refused', message: 'That is not the account password.', triesLeft: 2 })).toBe(
      'That is not the account password. 2 tries left.'
    )
    expect(refusalLine({ kind: 'refused', message: 'That is not the account password.', triesLeft: 1 })).toBe(
      'That is not the account password. 1 try left.'
    )
    expect(refusalLine({ kind: 'refused', message: 'Too many wrong tries. Try again in 60 s.', retryAfterMs: 59_500 })).toBe(
      'Too many wrong tries. Try again in 60 s.'
    )
  })
})
