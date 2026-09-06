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

  it('still answers for the registry and this Mac’s own addresses', () => {
    const allowed = allowedCompanionOrigins('https://cookrew.dev')
    expect(allowed).toContain('https://cookrew.dev')
    for (const own of mobileSelfOrigins()) expect(allowed).toContain(own)
    // Nothing empty rides in the list — an empty string would match a request
    // with no Origin header if anything ever compared them loosely.
    expect(allowed.every((origin) => origin.length > 0)).toBe(true)
  })

  it('answers for nobody when there is no registry configured', () => {
    const allowed = allowedCompanionOrigins('')
    expect(allowed).not.toContain('')
    expect(allowed).toEqual(mobileSelfOrigins())
  })
})
