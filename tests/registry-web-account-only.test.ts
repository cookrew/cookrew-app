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
 */

const asset = (name: string): string =>
  readFileSync(join(__dirname, '..', 'registry', 'assets', name), 'utf8')

describe('the line signs in as the account', () => {
  const line = asset('line.js')

  it('presents the v2 call token and never a v1 registry token', () => {
    expect(line).toContain('{ v2Token: seated.token }')
    expect(line).not.toContain('registryToken')
  })

  it('has no key ceremony left — no challenge signed with a browser key', () => {
    expect(line).not.toContain('cookrew-call/1')
    expect(line).not.toContain('acct.doorKey()')
    // The seal key stays: that is the door's encryption, not a caller identity.
    expect(line).toContain("root.dataset.sealKey")
  })

  it('does not decide who is reading from an enrolled handle', () => {
    expect(line).not.toContain('await acct?.handle()')
  })

  it('a door too old to take an account says so, rather than being met with a key', () => {
    expect(line).toContain("this door does not take cookrew.dev accounts yet")
  })
})

describe('nothing the line can reach opens the enrolment modal', () => {
  const site = asset('site.js')

  it('the exposed sign-in is the account sheet', () => {
    expect(site).toContain('signIn: openAccountSheet')
    expect(site).not.toContain('signIn: signInFlow')
  })

  it('a page without the sheet names where to sign in instead of enrolling', () => {
    expect(site).toContain('Open cookrew.dev/me to sign in.')
  })

  it('the enrolment flow keeps exactly the one caller it was written for', () => {
    // Stars, which are not a door and not a seat. If this count moves, a new
    // surface has started enrolling again and should be read before it ships.
    const callers = site.match(/(?<!function )signInFlow\(\)/g) ?? []
    expect(callers).toHaveLength(1)
  })
})
