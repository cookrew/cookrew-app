// THE GATE AND THE SENTENCE ARE ONE FACT (H2).
//
// The demotion of the root pairing token was off in every build that shipped
// — its only switch was an environment variable set nowhere — while the
// revoke sentence told the owner that revoking a device ends its access "on
// every Mac's Wi-Fi", and the code beside that sentence called it THE
// SECURITY CONTRACT. Two halves of one promise, in two files, with nothing
// holding them together.
//
// This is the thing that holds them together. It does not assert that the
// demotion is on or off; it asserts that whichever it is, the sentence says
// so. A lane that flips the constant and forgets the copy fails here, and so
// does a lane that softens the copy while the mechanism is live.

import { describe, expect, it } from 'vitest'
import { COMPANION_BOOTSTRAPS, lanRevokeEnds } from '../src/shared/lan-token-mode'
import { V3_COPY } from '../src/shared/account-copy'
import { revokeSentence } from '../src/renderer/src/account/account-store'
import { companionAccepted } from '../src/main/companion-gate'

const ROOT = 'the-root-pairing-token-abcdefgh'

/**
 * The claim under test: does this sentence tell the owner that access ENDS on
 * Wi-Fi?
 *
 * Not "does it mention Wi-Fi" — the honest hedge mentions Wi-Fi precisely to
 * say the opposite, and a predicate that could not tell the two apart would
 * pass the sentence that lies. The contract clause is the one the
 * architecture quotes, "on every Mac's Wi-Fi", said as one of the places the
 * device stops opening the account.
 */
const claimsWifiEnds = (sentence: string): boolean =>
  /stops opening[^.]*Wi-?Fi/i.test(sentence ?? '')

describe('the revoke sentence and the root-token gate cannot drift apart', () => {
  it('claims Wi-Fi exactly when the root token has been demoted', () => {
    const said = revokeSentence('iPhone')
    expect(claimsWifiEnds(said)).toBe(lanRevokeEnds())
  })

  it('names the action that IS sufficient while the root still opens everything', () => {
    if (lanRevokeEnds()) return
    const said = revokeSentence('iPhone')
    // Not "forget it below": while the root opens every route, forgetting the
    // row removes a credential the phone is not using. Rotation is the only
    // thing that ends a root-token phone's access, and it is what the pairing
    // sheet already tells the owner about.
    expect(said).toContain('--rotate')
    expect(said).toContain('at every door')
    expect(said).not.toContain("every Mac's Wi-Fi")
    // And it says the true thing about Wi-Fi rather than going quiet on it: a
    // sentence that simply dropped the clause would leave the owner to assume
    // whichever they assumed before.
    expect(said).toMatch(/keeps working on this Wi-Fi/i)
  })

  it('keeps the contract sentence ready, worded for the day the mechanism lands', () => {
    // The unhedged sentence stays in the table rather than being rewritten
    // later from memory: flipping the constant is the whole change.
    expect(claimsWifiEnds(V3_COPY['d12.revoke'])).toBe(true)
    expect(claimsWifiEnds(V3_COPY['d12.revoke.lan-pending'])).toBe(false)
  })

  it('agrees with what the gate actually does with a root token', () => {
    // The shipping default, read the way the server reads it. If this ever
    // answers false while the sentence claims Wi-Fi, the first test above is
    // the one that catches it — this is the other end of the same fact.
    const opensEverything = companionAccepted({
      route: 'other',
      presented: ROOT,
      rootToken: ROOT,
      perDevice: () => null,
      rootEverywhere: !COMPANION_BOOTSTRAPS
    })
    expect(opensEverything).toBe(!lanRevokeEnds())
  })
})
