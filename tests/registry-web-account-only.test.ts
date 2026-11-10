import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * THE MARKETPLACE PRESENTS ONE CREDENTIAL (v3, G1) — pinned as source, because
 * these are browser assets with no module boundary to test through.
 *
 * There used to be three ways to be somebody at a door: the account's call
 * token, a v1 registry token, and a key this browser enrolled under a bare
 * handle. The desktop was cut to one in V3-04; this is the same cut for the
 * web. A key-holder can never be the person a seat names, so a browser that
 * enrolled its way in could be charged again for a seat its account already
 * holds, and the room would list a stranger.
 *
 * The line itself (line.js) left with the team page in 0.6.0; what is pinned
 * here is the script that stays, site.js, which the account page loads.
 */

const asset = (name: string): string =>
  readFileSync(join(__dirname, '..', 'registry', 'assets', name), 'utf8')

describe('nothing the line can reach opens the enrolment modal', () => {
  const site = asset('site.js')

  it('the exposed sign-in is the one sign-in page, with the account sheet behind it', () => {
    expect(site).toContain("signIn: () => openSignIn('sign-in')")
    expect(site).toContain("openAccountSheet(intent === 'create' ? 'register' : undefined)")
    expect(site).not.toContain('signIn: signInFlow')
  })

  it('a page without the sheet names where to sign in instead of enrolling', () => {
    expect(site).toContain('Open cookrew.dev/me to sign in.')
  })

  it('the enrolment flow is gone — stars were its last caller, and they act as the account now', () => {
    // If either of these comes back, a surface has started enrolling a handle
    // again and should be read before it ships: everything is bound to the
    // username.
    expect(site).not.toContain('signInFlow')
    expect(site).not.toContain('/v1/identity/register')
  })
})
