// THE ACCOUNT SHEET'S THREE STATES AND THREE CROSSINGS (V3-02, D8 · D9) — the
// view-model, asserted without a DOM.
//
// The sheet asks three questions: which state am I in, may the primary be
// pressed, and what sentence goes under the name. All three are pure functions
// here, so the crossings — the moments a wrong tab is turned into the right
// one — can be pinned to the copy table's words before a component exists.

import { describe, expect, it } from 'vitest'
import type { AccountStatus } from '../src/shared/account-v2'
import { V3_COPY } from '../src/shared/account-copy'
import {
  ACCOUNT_COPY,
  SIGNIN_TRIES_PER_MINUTE,
  claimView,
  crossingFor,
  firstRunView,
  joinLede,
  registerView,
  signInView,
  triesFor,
} from '../src/renderer/src/account/account-store'

const STRONG = 'correct-horse-battery'

const BASE: AccountStatus = {
  username: null,
  displayName: '',
  avatar: null,
  locked: false,
  lockAfterMs: 900_000,
  requests: 0,
  envUsername: null,
  legacy: null,
  sessionExpired: false,
  registryMismatch: null,
  workspacesReachable: true,
  recoveryCodesSavedAt: null,
  recoveryCodesLeft: null,
}
const status = (over: Partial<AccountStatus> = {}): AccountStatus => ({ ...BASE, ...over })

describe('SIGN IN, the default state (D9)', () => {
  it('opens with the sign-in lede from the one copy table, and CONTINUE down', () => {
    const view = signInView({ username: '', password: '' })
    expect(view.lede).toBe(V3_COPY['d9.signin.lede'])
    expect(view.primary).toBe('CONTINUE')
    expect(view.canGo).toBe(false)
    expect(view.username.note).toBe(ACCOUNT_COPY.SIGNIN_USERNAME_HINT)
    expect(view.password.note).toBe(ACCOUNT_COPY.SIGNIN_PASSWORD_HINT)
  })

  it('has no length gate and no availability check: an existing password is whatever it is', () => {
    const view = signInView({ username: '@drej', password: 'short' })
    expect(view.canGo).toBe(true)
    expect(view.username.tag).toBe('')
    expect(view.password.tag).toBe('')
  })

  it('still refuses a name that is not a name, with the rule', () => {
    const view = signInView({ username: 'Not A Name', password: 'x' })
    expect(view.username.tone).toBe('bad')
    expect(view.username.note).toBe(ACCOUNT_COPY.USERNAME_INVALID)
    expect(view.canGo).toBe(false)
  })

  it('says what NOT NOW keeps, in the D9 words', () => {
    expect(signInView({ username: '', password: '' }).footNote).toBe(ACCOUNT_COPY.NOT_NOW)
    expect(ACCOUNT_COPY.NOT_NOW).toContain('sign in later from the avatar')
  })

  it('after a crossing from CREATE, the name wears "yours?" and the crossing sentence', () => {
    const crossed = crossingFor({
      state: 'register',
      username: 'drej',
      refusal: { reason: 'taken' },
    })
    expect(crossed).toEqual({ kind: 'cross', to: 'signin', sentence: V3_COPY['d9.crossing.taken'].replace('{handle}', 'drej') })
    const view = signInView({ username: 'drej', password: '' }, crossed.kind === 'cross' ? crossed.sentence : null)
    expect(view.username.tag).toBe('yours?')
    expect(view.username.note).toBe('@drej already exists — sign in with your password.')
  })
})

describe('CREATE ACCOUNT, under a tab (D9)', () => {
  const fields = (over: Partial<Parameters<typeof claimView>[0]> = {}) => ({
    username: '',
    check: 'invalid' as const,
    password: '',
    confirm: '',
    ...over,
  })

  it('is D2 with the create lede and CREATE on the button', () => {
    const view = registerView(fields({ username: 'drej', check: 'free' }))
    expect(view.lede).toBe(V3_COPY['d9.create.lede'])
    expect(view.primary).toBe('CREATE @DREJ')
    expect(registerView(fields()).primary).toBe('CREATE')
  })

  it('keeps the primary down until the name is FREE and both password lines are green', () => {
    expect(registerView(fields({ username: 'drej', check: 'free' })).canClaim).toBe(false)
    expect(
      registerView(fields({ username: 'drej', check: 'free', password: STRONG, confirm: STRONG }))
        .canClaim,
    ).toBe(true)
    expect(
      registerView(fields({ username: 'drej', check: 'unknown', password: STRONG, confirm: STRONG }))
        .canClaim,
    ).toBe(false)
  })

  it('after a crossing from SIGN IN, a free name carries the take-it-now sentence', () => {
    const view = registerView(
      fields({ username: 'foo', check: 'free' }),
      'There is no @foo yet — take it now.',
    )
    expect(view.username.tag).toBe('free ✓')
    expect(view.username.note).toBe('There is no @foo yet — take it now.')
  })

  it('but a crossing sentence never outlives the check that made it true', () => {
    const view = registerView(
      fields({ username: 'foo', check: 'taken' }),
      'There is no @foo yet — take it now.',
    )
    expect(view.username.note).not.toContain('take it now')
  })
})

describe('the three crossings — a wrong tab is never a dead end (D9)', () => {
  it('CREATE + name exists → SIGN IN with the name kept and the table’s sentence', () => {
    expect(crossingFor({ state: 'register', username: '@drej', refusal: { reason: 'taken' } })).toEqual({
      kind: 'cross',
      to: 'signin',
      sentence: '@drej already exists — sign in with your password.',
    })
  })

  it('SIGN IN + bad credentials + HEAD 404 → CREATE with the take-it-now sentence', () => {
    for (const reason of ['bad_credentials', 'session-expired'] as const) {
      // Main maps a refused password to 'session-expired' (v3-01); both
      // spellings are the same fact to this sheet.
      expect(
        crossingFor({ state: 'signin', username: 'foo', refusal: { reason }, check: 'free', wrongTries: 1 }),
      ).toEqual({ kind: 'cross', to: 'register', sentence: 'There is no @foo yet — take it now.' })
    }
  })

  it('SIGN IN + wrong password on a name that exists → stays, with the tries left', () => {
    const landing = crossingFor({
      state: 'signin',
      username: 'drej',
      refusal: { reason: 'session-expired', message: 'That name and password do not go together.' },
      check: 'taken',
      wrongTries: 1,
    })
    expect(landing).toEqual({ kind: 'stay', sentence: 'Not it. 4 tries left before a 1-minute pause.' })
    expect(SIGNIN_TRIES_PER_MINUTE).toBe(5)
  })

  it('a HEAD that did not answer is not a crossing: nobody is sent to CREATE on a guess', () => {
    for (const check of ['unknown', null] as const) {
      const landing = crossingFor({
        state: 'signin',
        username: 'drej',
        refusal: { reason: 'bad_credentials' },
        check,
        wrongTries: 2,
      })
      expect(landing).toEqual({ kind: 'stay', sentence: 'Not it. 3 tries left before a 1-minute pause.' })
    }
  })

  it('the last try and the pause say the pause, not a negative number', () => {
    expect(
      crossingFor({ state: 'signin', username: 'drej', refusal: { reason: 'bad_credentials' }, check: 'taken', wrongTries: 5 }),
    ).toEqual({ kind: 'stay', sentence: 'Too many tries. Wait 60 seconds and try again.' })
    expect(
      crossingFor({ state: 'signin', username: 'drej', refusal: { reason: 'rate_limited' } }),
    ).toEqual({ kind: 'stay', sentence: 'Too many tries. Wait 60 seconds and try again.' })
  })

  it('counts the tries against the NAME, so a crossing does not spend another name’s budget', () => {
    // The registry's budget is per account. A tally carried across a change of
    // name would have the sheet say "3 tries left" where cookrew.dev still
    // allows four — a number offered as a fact, that is not one.
    const first = triesFor({ name: '', count: 0 }, 'nosuchperson', true)
    expect(first).toEqual({ name: 'nosuchperson', count: 1 })

    const afterCrossing = triesFor(first, 'drej', true)
    expect(afterCrossing).toEqual({ name: 'drej', count: 1 })
    expect(
      crossingFor({
        state: 'signin',
        username: 'drej',
        refusal: { reason: 'bad_credentials' },
        check: 'taken',
        wrongTries: afterCrossing.count,
      }),
    ).toEqual({ kind: 'stay', sentence: 'Not it. 4 tries left before a 1-minute pause.' })

    // Staying on the name keeps counting it down.
    expect(triesFor(afterCrossing, 'drej', true)).toEqual({ name: 'drej', count: 2 })
  })

  it('only a refused password spends a try — a pause or a ladder does not', () => {
    const held = { name: 'drej', count: 2 }
    expect(triesFor(held, 'drej', false)).toEqual({ name: 'drej', count: 2 })
    // …and an unrelated name that was never refused still starts clean.
    expect(triesFor(held, 'someone', false)).toEqual({ name: 'someone', count: 0 })
  })

  it('SIGN IN on a device the account has not seen → the ladder, with the join lede (D10)', () => {
    const landing = crossingFor({
      state: 'signin',
      username: 'drej',
      refusal: { reason: 'second_factor' },
    })
    expect(landing).toEqual({ kind: 'ladder', lede: joinLede('drej') })
    expect(joinLede('drej')).toBe('@drej is already on another device. Prove it is you and this Mac joins.')
  })

  it('CREATE on a name a v1 key holds stays put, and says whose it is', () => {
    const landing = crossingFor({ state: 'register', username: 'drej', refusal: { reason: 'legacy' } })
    expect(landing.kind).toBe('stay')
    expect(landing.kind === 'stay' && landing.sentence).toContain('from before passwords')
  })

  it('any other refusal stays, with the registry’s own sentence when it sent one', () => {
    expect(
      crossingFor({ state: 'signin', username: 'drej', refusal: { reason: 'taken', message: 'This Mac is already @anvz.' } }),
    ).toEqual({ kind: 'stay', sentence: 'This Mac is already @anvz.' })
    expect(
      crossingFor({ state: 'register', username: 'drej', refusal: { reason: 'offline' } }),
    ).toEqual({ kind: 'stay', sentence: ACCOUNT_COPY.REGISTRY_DOWN })
  })
})

describe('the first-run card (D8) — once, and only on a fresh install', () => {
  const fresh = { status: status(), workspaceCount: 1, dismissed: false }

  it('is placed when there is no account, no v1 key and no workspace of the person’s own', () => {
    const view = firstRunView(fresh)
    expect(view).not.toBeNull()
    expect(view?.title).toBe(ACCOUNT_COPY.FIRST_RUN_TITLE)
    expect(view?.lede).toBe(ACCOUNT_COPY.FIRST_RUN_LEDE)
  })

  it('offers SIGN IN WITH PASSWORD · CREATE AN ACCOUNT · NOT NOW, in that order, and no JOIN in cut 1', () => {
    const view = firstRunView(fresh)
    expect(view?.buttons.map((b) => b.label)).toEqual([
      'SIGN IN WITH PASSWORD',
      'CREATE AN ACCOUNT',
      'NOT NOW',
    ])
    expect(view?.buttons.map((b) => b.action)).toEqual(['signin', 'register', 'dismiss'])
    expect(view?.join).toBeNull()
  })

  it('is not placed once it was closed, or once anything exists here', () => {
    expect(firstRunView({ ...fresh, dismissed: true })).toBeNull()
    expect(firstRunView({ ...fresh, status: status({ username: 'drej' }) })).toBeNull()
    expect(firstRunView({ ...fresh, status: status({ legacy: { handle: 'drej' } }) })).toBeNull()
    expect(firstRunView({ ...fresh, workspaceCount: 2 })).toBeNull()
  })

  it('waits until both facts are known rather than flashing on a guess', () => {
    expect(firstRunView({ ...fresh, status: null })).toBeNull()
    expect(firstRunView({ ...fresh, workspaceCount: null })).toBeNull()
  })
})
