// REACH v2.1, PHASE S3 — ONE CREDENTIAL, CARRIED IN A FRAGMENT.
//
// The Mac prints exactly one thing now:
//
//   https://192-168-2-40.<uuid>.d.cookrew.dev:8643/#pair=<token>   (a machine's own page)
//
// The token sits in the FRAGMENT for a reason a reviewer should not have to
// take on trust: a fragment is never sent to the server, so cookrew.dev —
// which serves the shell and relays the line — never sees the credential that
// authorises the phone at the Mac. What is asserted below is that, and the
// three ways that guarantee can be lost quietly:
//
//   THE FRAGMENT SURVIVING THE BOOT. A token left in the address bar is in
//   every screenshot, every share sheet and every reload of that page.
//
//   ONE KEY FOR MANY MACS. cookrew.dev now hosts every desktop the owner has
//   at the same ORIGIN, so one localStorage key would hand Mac B the token of
//   Mac A — a 401 that looks like "randomly unpaired" and, worse, a credential
//   sent to a machine it was never minted for.
//
//   A SHORT TOKEN SLIPPING THROUGH. `#pair=` is machine-written; anything that
//   is not the shape the Mac mints (24 random bytes, base64url) is junk that
//   would be stored and then refused one screen later.

import { describe, expect, it } from 'vitest'
import {
  DESKTOP_TOKEN_PREFIX,
  ROOT_TOKEN_KEY,
  codeKeyForBase,
  connectCodeFromFragment,
  desktopIdFromBase,
  isPairingToken,
  scrubPairingFromUrl,
  stripPairFragment,
  tokenFromFragment,
  tokenKeyForBase
} from '../src/renderer/src/pairing-scope'

const DEVICE = '11111111-2222-3333-4444-555555555555'
/** A machine's address on the relay, as the console reaches it. */
const BASE = `https://api.cookrew.dev/api/m/${DEVICE}`
/** 24 random bytes, base64url — exactly what `loadOrCreatePairingToken` mints. */
const TOKEN = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MEFC'

describe('the token shape', () => {
  it('accepts what the Mac mints and nothing shorter', () => {
    expect(TOKEN).toHaveLength(32)
    expect(isPairingToken(TOKEN)).toBe(true)
    expect(isPairingToken('a'.repeat(16))).toBe(true)
    expect(isPairingToken('a'.repeat(128))).toBe(true)
  })

  it('refuses junk that would be stored and then refused a screen later', () => {
    expect(isPairingToken('a'.repeat(15))).toBe(false)
    expect(isPairingToken('a'.repeat(129))).toBe(false)
    // Not base64url: a fragment carrying these came from somewhere else.
    expect(isPairingToken('abcdefghijklmnop=')).toBe(false)
    expect(isPairingToken('abcdefghijk lmnop')).toBe(false)
    expect(isPairingToken('abcdefghij/lmnop')).toBe(false)
  })
})

describe('tokenFromFragment', () => {
  it('reads the canonical #pair= the Mac prints', () => {
    expect(tokenFromFragment(`#pair=${TOKEN}`)).toBe(TOKEN)
  })

  it('reads the #/pair= form too — a router prefix is not a different link', () => {
    expect(tokenFromFragment(`#/pair=${TOKEN}`)).toBe(TOKEN)
  })

  it('finds it beside other fragment state rather than only alone', () => {
    expect(tokenFromFragment(`#/tab=canvas&pair=${TOKEN}`)).toBe(TOKEN)
  })

  it('has nothing to say about an ordinary fragment', () => {
    expect(tokenFromFragment('')).toBeNull()
    expect(tokenFromFragment('#')).toBeNull()
    expect(tokenFromFragment('#/settings')).toBeNull()
    expect(tokenFromFragment('#token=abc')).toBeNull()
  })

  it('refuses a mis-shaped token instead of storing it', () => {
    expect(tokenFromFragment('#pair=short')).toBeNull()
    expect(tokenFromFragment('#pair=')).toBeNull()
  })
})

describe('stripPairFragment', () => {
  it('removes the whole fragment when the token was all it carried', () => {
    expect(stripPairFragment(`#pair=${TOKEN}`)).toBe('')
    expect(stripPairFragment(`#/pair=${TOKEN}`)).toBe('')
  })

  it('keeps the rest of the fragment, and its leading slash', () => {
    expect(stripPairFragment(`#/tab=canvas&pair=${TOKEN}`)).toBe('#/tab=canvas')
  })

  it('leaves a fragment with no token exactly as it found it', () => {
    expect(stripPairFragment('#/settings')).toBe('#/settings')
    expect(stripPairFragment('')).toBe('')
  })
})

describe('scrubPairingFromUrl — the credential must not survive the boot', () => {
  it('takes the fragment off a machine’s own pairing link', () => {
    // A pairing link is to a machine's own page now: the console carries no credential in its address.
    const href = `https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643/#pair=${TOKEN}`
    expect(scrubPairingFromUrl(href)).toBe(`https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643/`)
  })

  it('takes ?token= off the direct LAN URL, as it always did', () => {
    expect(scrubPairingFromUrl(`https://192.168.2.40:8643/?token=${TOKEN}`)).toBe(
      'https://192.168.2.40:8643/'
    )
  })

  it('answers null when there is nothing to scrub, so no history entry is written', () => {
    expect(scrubPairingFromUrl('https://console.cookrew.dev/d/x')).toBeNull()
    expect(scrubPairingFromUrl('not a url')).toBeNull()
  })
})

describe('desktopIdFromBase / tokenKeyForBase — one origin, many Macs', () => {
  it('lifts the machine id out of its relay address', () => {
    expect(desktopIdFromBase(BASE)).toBe(DEVICE)
    expect(desktopIdFromBase(`${BASE}/`)).toBe(DEVICE)
    expect(desktopIdFromBase(`/api/m/${DEVICE}`)).toBe(DEVICE)
    // The address ENDS with the id: a longer path is a route on that machine, not its address.
    expect(desktopIdFromBase(`${BASE}/api/fleet`)).toBeNull()
  })

  it('lower-cases the id, so one Mac never gets two keys', () => {
    expect(desktopIdFromBase(BASE.toUpperCase())).toBe(DEVICE)
  })

  it('has no id for a base that is not a relay prefix', () => {
    expect(desktopIdFromBase('')).toBeNull()
    expect(desktopIdFromBase('https://api.cookrew.dev/api/m/not-a-uuid')).toBeNull()
    // The address a machine's page had before 0.6.0 names nobody now.
    expect(desktopIdFromBase(`/relay/@owner/desktop/${DEVICE}`)).toBeNull()
    expect(desktopIdFromBase('/some/other/prefix')).toBeNull()
  })

  it('keeps TODAY’S key at the root, so every LAN pairing survives this change', () => {
    expect(tokenKeyForBase('')).toBe(ROOT_TOKEN_KEY)
    expect(ROOT_TOKEN_KEY).toBe('cookrew-pairing-token')
  })

  it('keys the token by desktop under a relay prefix', () => {
    expect(tokenKeyForBase(BASE)).toBe(`${DESKTOP_TOKEN_PREFIX}${DEVICE}`)
    expect(tokenKeyForBase(`${BASE}/`)).toBe(`${DESKTOP_TOKEN_PREFIX}${DEVICE}`)
  })

  it('never falls back to the ROOT key for an unrecognised base', () => {
    // A base we cannot read is still not the root: reusing the root key there
    // would hand this Mac whichever token the last direct pairing left behind.
    const key = tokenKeyForBase('https://api.cookrew.dev/api/m/not-a-uuid')
    expect(key).not.toBe(ROOT_TOKEN_KEY)
    expect(key.startsWith(DESKTOP_TOKEN_PREFIX)).toBe(true)
  })
})

describe('the connect code', () => {
  const CODE = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQ'

  it('rides the same fragment as the token', () => {
    expect(connectCodeFromFragment(`#pair=${TOKEN}&code=${CODE}`)).toBe(CODE)
    expect(tokenFromFragment(`#pair=${TOKEN}&code=${CODE}`)).toBe(TOKEN)
  })

  it('is 32 bytes or nothing', () => {
    expect(connectCodeFromFragment('#code=short')).toBeNull()
    expect(connectCodeFromFragment(`#code=${CODE}A`)).toBeNull()
    expect(connectCodeFromFragment('')).toBeNull()
  })

  it('leaves the address bar with the token', () => {
    expect(stripPairFragment(`#pair=${TOKEN}&code=${CODE}`)).toBe('')
    expect(stripPairFragment(`#code=${CODE}&x=1`)).toBe('#x=1')
    const clean = scrubPairingFromUrl(`https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643/#pair=${TOKEN}&code=${CODE}`)
    expect(clean).toBe(`https://192-168-2-40.${DEVICE}.d.cookrew.dev:8643/`)
  })

  it('is kept per desktop: one origin hosts many Macs', () => {
    expect(codeKeyForBase(BASE)).toBe(`cr_code:${DEVICE}`)
    expect(codeKeyForBase('')).toBe('cr_code')
  })
})

