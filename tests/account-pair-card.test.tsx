import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ReauthAccountEntry, refusalLine } from '../src/renderer/src/ReauthAccountEntry'
import type { PairClientDeps } from '../src/renderer/src/account-pair-client'
import { REAUTH_COPY, machineSentence } from '../src/renderer/src/auth-gate'

/**
 * THE ACCOUNT'S WAY IN, AS THE PHONE DRAWS IT (owner 2026-11-09).
 *
 * The first paint is "entering": the card tries the pass it holds before it
 * asks anything, so a second machine within twelve hours opens with no prompt.
 */

const deps: PairClientDeps = {
  machine: { get: async () => ({ status: 200, body: null }), post: async () => ({ status: 200, body: null }) },
  registry: { get: async () => ({ status: 200, body: null }), post: async () => ({ status: 200, body: null }) },
  device: async () => null,
  passkey: null,
  grants: { read: () => null, write: () => undefined, clear: () => undefined }
}

describe('the account entry on the Not paired card', () => {
  it('first tries the pass it holds, asking nothing', () => {
    const markup = renderToStaticMarkup(
      <ReauthAccountEntry offer={{ offered: true, desktopId: 'd', platform: 'linux' }} deps={deps} handle="anvztor" onEntered={async () => true} />
    )
    expect(markup).toContain(REAUTH_COPY.enterEntering)
    expect(markup).not.toContain('current-password')
  })

  it('says this machine on Linux, Mac on a Mac, and twelve hours for every machine', () => {
    expect(machineSentence(REAUTH_COPY.enterLede, 'linux')).toBe(
      'Enter this machine with your account — a passkey, or the account password. Every machine of your account then lets this browser in for twelve hours.'
    )
    expect(machineSentence(REAUTH_COPY.enterLede, 'darwin')).toContain('Enter this Mac')
    for (const sentence of [REAUTH_COPY.enterSetPassword, REAUTH_COPY.enterUnreachable, REAUTH_COPY.enterSignIn, REAUTH_COPY.enterKept]) {
      expect(machineSentence(sentence, 'linux')).not.toMatch(/\bMac\b/)
    }
  })

  it('a provider-only account is told to set a password first (ruling 3)', () => {
    expect(REAUTH_COPY.enterSetPassword).toMatch(/^Set an account password first/)
  })

  it('says how many tries are left, and when to come back', () => {
    expect(refusalLine({ message: 'That is not the account password.', triesLeft: 2 })).toBe('That is not the account password. 2 tries left.')
    expect(refusalLine({ message: 'That is not the account password.', triesLeft: 1 })).toBe('That is not the account password. 1 try left.')
    expect(refusalLine({ message: 'Too many wrong tries. Try again in a minute.', retryAfterMs: 59_500 })).toBe('Too many wrong tries. Try again in 60 s.')
  })
})
