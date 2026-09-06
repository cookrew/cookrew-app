// ONE MORE STEP, AND SOMEWHERE TO TAKE IT.
//
// The live bug: cookrew.dev answered the owner's correct password with 401
// second_factor, and the card printed "One more step. Prove it is you." with
// nothing under it — no field, no button, no way on. So the invariant asserted
// here is not "the ladder renders": it is that WHEREVER that sentence appears,
// a rung appears with it, and that every rung on screen is one the registry
// actually offered.
//
// A static render runs the component body and the markup IS the picture, which
// is the house pattern (account-render, reauth-card-render).

import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SecondFactorStep, LadderFactor } from '../src/shared/account-v2'
import { ResumeLadder } from '../src/renderer/src/account/ResumeLadder'
import { ACCOUNT_COPY } from '../src/renderer/src/account/account-store'

/** The bridge, as the surface feature-detects it. No DOM under the server renderer. */
beforeEach(() => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: {
      accountResumeCode: async () => ({ ok: false, reason: 'bad_code' }),
      accountResumeAsk: async () => ({ ok: false, reason: 'expired' }),
      accountResumeWait: async () => ({ ok: false, reason: 'expired' }),
    },
  }
})

const REGISTRY_SENTENCE = 'One more step. Prove it is you.'

const step = (next: readonly LadderFactor[]): SecondFactorStep => ({
  pending: '11111111-2222-4333-8444-555555555555',
  next,
  expiresAt: Date.now() + 600_000,
})

const ladder = (next: readonly LadderFactor[], lede = REGISTRY_SENTENCE): string =>
  renderToStaticMarkup(
    <ResumeLadder
      step={step(next)}
      lede={lede}
      onSignedIn={() => undefined}
      onOver={() => undefined}
    />,
  )

describe('the ladder is the sentence AND a rung, never one of them', () => {
  it('opens on the authenticator: a six-digit field and VERIFY', () => {
    const html = ladder(['totp', 'approve', 'recovery'])
    // The registry's own sentence, carried verbatim — it is the only party
    // that knows why THIS sign-in was stopped.
    expect(html).toContain(REGISTRY_SENTENCE)
    expect(html).toContain(ACCOUNT_COPY.LADDER_TOTP_LABEL)
    expect(html).toContain('>VERIFY</button>')
    expect(html).toContain('maxLength="6"')
    expect(html).toContain('inputMode="numeric"')
    expect(html).toContain('placeholder="123456"')
    // A code field is never a password field: the browser must not offer to
    // save six digits that are good for thirty seconds.
    expect(html).toContain('autoComplete="one-time-code"')
    expect(html).not.toContain('type="password"')
  })

  it('offers the other ways without hiding the one that is open', () => {
    const html = ladder(['totp', 'approve', 'recovery'])
    expect(html).toContain('Use a recovery code')
    expect(html).toContain(ACCOUNT_COPY.LADDER_ASK)
    // …and the field it opened on is still there underneath them.
    expect(html).toContain(ACCOUNT_COPY.LADDER_TOTP_HINT)
  })

  it('opens on the rescue code when that is all the account has', () => {
    const html = ladder(['recovery'])
    expect(html).toContain(ACCOUNT_COPY.LADDER_RECOVERY_LABEL)
    expect(html).toContain('placeholder="ABCD-EFGH"')
    expect(html).toContain(ACCOUNT_COPY.LADDER_RECOVERY_HINT)
    // Nothing that was not offered: no authenticator, no other device.
    expect(html).not.toContain('Use the authenticator')
    expect(html).not.toContain(ACCOUNT_COPY.LADDER_ASK)
  })

  it('is a button and no field when the only way is another device', () => {
    const html = ladder(['approve'])
    expect(html).toContain(ACCOUNT_COPY.LADDER_ASK)
    expect(html).not.toContain('<input')
    expect(html).not.toContain('>VERIFY</button>')
  })

  it('swaps the authenticator back in from the rescue rung', () => {
    // The two typed rungs each name the other, so neither is a one-way door.
    expect(ladder(['totp', 'recovery'])).toContain('Use a recovery code')
    expect(ladder(['recovery', 'totp'])).toContain('Use a recovery code')
    expect(ladder(['approve', 'totp'])).toContain(ACCOUNT_COPY.LADDER_TOTP_LABEL)
  })

  it('draws NO passkey rung, because this build cannot climb one', () => {
    // webauthn.ts translates enrolment only — there is no `get()` in it — and
    // a button that raised the OS security-key dialog and then failed would be
    // a rung nobody can stand on. Better a shorter ladder.
    const html = ladder(['passkey', 'totp', 'approve'])
    expect(html.toLowerCase()).not.toContain('passkey')
    // And the rungs that ARE climbable are all still on screen.
    expect(html).toContain(ACCOUNT_COPY.LADDER_TOTP_LABEL)
    expect(html).toContain(ACCOUNT_COPY.LADDER_ASK)
  })

  it('falls back to our own sentence when the registry sent none', () => {
    expect(ladder(['totp'], ACCOUNT_COPY.SESSION_SECOND_FACTOR)).toContain(
      ACCOUNT_COPY.SESSION_SECOND_FACTOR,
    )
  })
})
