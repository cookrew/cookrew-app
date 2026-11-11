import { describe, expect, it } from 'vitest'
import { allowedCompanionOrigins, mobileSelfOrigins, trustedOrigins } from '../src/main/mobile-server'

/**
 * THE DEFAULT IS "NOTHING IS TRUSTED", and it has to be, on this exact
 * machine: nothing has attached a certificate to the running server, so every
 * reader — the reach card, the CORS allow-list, the printed URLs — must see an
 * empty list rather than a name that would not resolve or would not validate.
 */

describe('the trusted origins a bare server publishes', () => {
  it('is empty until a certificate is attached', () => {
    // `startMobileServer` has not run here, so no chain is held.
    expect(trustedOrigins()).toEqual([])
  })

  it('still answers for the console and this Mac’s own addresses, and for no other page', () => {
    const allowed = allowedCompanionOrigins('https://console.cookrew.dev')
    expect(allowed).toContain('https://console.cookrew.dev')
    // 0.6.0: the one page that reaches a machine from another origin is the console. Not the
    // intro site, not the sign-in host, not the API host (which serves no page at all).
    for (const other of ['https://cookrew.dev', 'https://auth.cookrew.dev', 'https://api.cookrew.dev']) expect(allowed).not.toContain(other)
    for (const own of mobileSelfOrigins()) expect(allowed).toContain(own)
    // Nothing empty rides in the list — an empty string would match a request
    // with no Origin header if anything ever compared them loosely.
    expect(allowed.every((origin) => origin.length > 0)).toBe(true)
  })

  it('answers for nobody else when no console is configured', () => {
    const allowed = allowedCompanionOrigins('')
    expect(allowed).not.toContain('')
    expect(allowed).toEqual(mobileSelfOrigins())
  })
})
