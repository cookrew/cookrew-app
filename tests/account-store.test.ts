// THE VIEW-MODEL BEHIND THE ACCOUNT SURFACE — the states, and the sentences.
//
// The copy IS the product here: every refusal is a sentence from the UI/UX
// design's copy table, and a screen that says "409" is the failure the design
// exists to prevent. So these tests assert the words, not just the branch.

import { describe, expect, it } from 'vitest'
import type { AccountStatus } from '../src/shared/account-v2'
import {
  ACCOUNT_COPY,
  approvalView,
  avatarView,
  claimView,
  deviceName,
  factorRows,
  initialsOf,
  lockLabel,
  lockNote,
  lockRowLabel,
  mustChangeBanner,
  passkeyElsewhere,
  profileKey,
  removeFactorPrompt,
  refusalSentence,
  rescueState,
  revokeSentence,
  takenSentence,
  wrongPasswordSentence,
} from '../src/renderer/src/account/account-store'
import { startedAgo, type ApprovalRequest } from '../src/shared/account-approvals'

const STRONG = 'correct-horse-battery'

/** A complete status; `over` is spread over it so the result stays AccountStatus
 *  rather than every field widening to include undefined. */
const BASE: AccountStatus = {
  username: 'drej',
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

describe('the avatar, in three states (D1)', () => {
  it('reads as NOBODY YET before an account, and never nags', () => {
    const view = avatarView(null)
    expect(view.state).toBe('none')
    expect(view.initials).toBe('?')
    expect(view.badge).toBeNull()
    // The hover explains what an account buys AND that nothing here needs one.
    expect(view.title).toBe(ACCOUNT_COPY.NO_ACCOUNT)
    expect(view.title).toContain('Everything here works without one.')
  })

  it('wears initials once claimed', () => {
    expect(avatarView(status()).initials).toBe('DR')
    expect(avatarView(status({ displayName: 'Drej Smith' })).initials).toBe('DS')
    expect(initialsOf('a')).toBe('A')
    expect(initialsOf(null)).toBe('?')
  })

  it('carries an uploaded picture rather than the initials', () => {
    expect(avatarView(status({ avatar: 'data:image/png;base64,x' })).avatar).toBe(
      'data:image/png;base64,x',
    )
  })

  it('shows the rose badge when a device is waiting (the D6 seam)', () => {
    const view = avatarView(status({ requests: 2 }))
    expect(view.badge).toBe(2)
    expect(view.title).toContain('2 devices waiting')
    // Zero is not a badge — an empty rose dot would be a permanent alarm.
    expect(avatarView(status({ requests: 0 })).badge).toBeNull()
  })
})

describe('the claim sheet decides, and always says why (D2)', () => {
  const fields = (over: Partial<Parameters<typeof claimView>[0]> = {}) =>
    claimView({ username: '', check: 'invalid', password: '', confirm: '', ...over })

  it('keeps the primary DOWN until both lines are green', () => {
    expect(fields().canClaim).toBe(false)
    expect(fields({ username: 'drej', check: 'free' }).canClaim).toBe(false)
    expect(
      fields({ username: 'drej', check: 'free', password: STRONG, confirm: STRONG }).canClaim,
    ).toBe(true)
  })

  it('names the act on the button', () => {
    expect(fields({ username: '@drej', check: 'free' }).primary).toBe('CLAIM @DREJ')
    expect(fields().primary).toBe('CLAIM')
  })

  it('refuses a taken name in the copy table’s words', () => {
    const view = fields({ username: 'anvz', check: 'taken' })
    expect(view.username.tone).toBe('bad')
    expect(view.username.note).toBe("@anvz is someone else's. Try another.")
    expect(view.canClaim).toBe(false)
  })

  it('refuses a name that is not a name, with the rule', () => {
    const view = fields({ username: 'Drej Smith', check: 'free' })
    expect(view.username.note).toBe('A username is lowercase letters, digits and dashes.')
    // Even a "free" answer cannot enable a name the rules refuse.
    expect(view.canClaim).toBe(false)
  })

  it('NEVER lets an unchecked name through — the registry-down sentence', () => {
    const view = fields({
      username: 'drej',
      check: 'unknown',
      password: STRONG,
      confirm: STRONG,
    })
    expect(view.username.note).toBe(ACCOUNT_COPY.REGISTRY_DOWN)
    expect(view.username.note).toContain('Nothing local stops.')
    expect(view.canClaim).toBe(false)
  })

  it('waits, visibly, while the check is in flight', () => {
    const view = fields({ username: 'drej', check: 'checking' })
    expect(view.username.tag).toBe('checking…')
    expect(view.canClaim).toBe(false)
  })

  it('meters the password and states the rule under it', () => {
    expect(fields({ password: 'short' }).password.tone).toBe('bad')
    expect(fields({ password: 'short' }).password.note).toBe(ACCOUNT_COPY.PASSWORD_WEAK)
    expect(fields({ password: STRONG }).password.tag).toBe('strong')
    expect(fields({ password: STRONG }).password.note).toBe(ACCOUNT_COPY.PASSWORD_RULE)
    // The rule names the floor, what it does, and where it goes.
    expect(ACCOUNT_COPY.PASSWORD_RULE).toContain('At least 12 characters')
    expect(ACCOUNT_COPY.PASSWORD_RULE).toContain('only to cookrew.dev')
  })

  it('says the two do not match yet, rather than going quiet', () => {
    const view = fields({ password: STRONG, confirm: 'other-password' })
    expect(view.confirm.tone).toBe('bad')
    expect(view.confirm.note).toBe(ACCOUNT_COPY.CONFIRM_MISMATCH)
    expect(fields({ password: STRONG, confirm: STRONG }).confirm.tag).toBe('matches ✓')
  })
})

describe('a reserved prefix gets the REAL reason', () => {
  const fields = (over: Partial<Parameters<typeof claimView>[0]> = {}) =>
    claimView({ username: '', check: 'invalid', password: '', confirm: '', ...over })

  it('names the prefix instead of the lowercase-and-dashes rule', () => {
    // The lie this replaces: `acct-x` is already lowercase, so being told to
    // use lowercase left the person retyping a name that could never work.
    const view = fields({ username: 'acct-x', check: 'free' })
    expect(view.username.tag).toBe('reserved')
    expect(view.username.note).toBe('acct- is reserved for the doors — pick another name.')
    expect(view.username.note).not.toBe(ACCOUNT_COPY.USERNAME_INVALID)
    expect(view.canClaim).toBe(false)
  })

  it('still says the shape rule for a name that really is malformed', () => {
    expect(fields({ username: 'Drej', check: 'free' }).username.note).toBe(
      ACCOUNT_COPY.USERNAME_INVALID,
    )
  })

  it('refuses a reserved name even if the registry answered "free"', () => {
    expect(
      fields({ username: 'acct-x', check: 'free', password: STRONG, confirm: STRONG }).canClaim,
    ).toBe(false)
  })
})

describe('the lock delay is a closed list, said in words', () => {
  it('names each choice, and off', () => {
    expect(lockLabel(60_000)).toBe('1 min')
    expect(lockLabel(900_000)).toBe('15 min')
    expect(lockLabel(1_800_000)).toBe('30 min')
    expect(lockLabel(0)).toBe('off')
  })

  it('never calls an unrecognised delay OFF', () => {
    // The one wrong answer a security card can give: a lock that IS armed,
    // described as off.
    expect(lockLabel(120_000)).toBe('2 min')
  })

  it('labels the row with the delay it will actually wait', () => {
    expect(lockRowLabel(300_000)).toBe('Lock Cookrew after 5 min idle')
    expect(lockRowLabel(0)).toBe('Lock Cookrew when idle')
  })
})

describe('the RESCUE row stops saying NOT SAVED once they are saved', () => {
  /** A fixed formatter: the date's rendering is the locale's business. */
  const on = (): string => 'X'

  it('says NOT SAVED before anything happened', () => {
    expect(rescueState(null, null)).toEqual({ saved: false, label: 'NOT SAVED' })
    expect(rescueState(undefined, undefined)).toEqual({ saved: false, label: 'NOT SAVED' })
  })

  it('says when they were saved, with a check', () => {
    expect(rescueState(1_757_116_800_000, null, on)).toEqual({ saved: true, label: 'Saved X' })
  })

  it('adds the registry’s remaining count when it sent one', () => {
    expect(rescueState(1_757_116_800_000, 6, on).label).toBe('Saved X · 6 left')
  })

  it('counts as saved on the registry’s count alone', () => {
    // Codes exist on the account even if this Mac never recorded saving them.
    expect(rescueState(null, 8)).toEqual({ saved: true, label: '8 LEFT' })
    expect(rescueState(null, 0).saved).toBe(false)
  })
})

describe('a device is named the way its owner named it', () => {
  it('drops the mDNS .local suffix and nothing else', () => {
    expect(deviceName("Drej's MacBook Pro.local")).toBe("Drej's MacBook Pro")
    expect(deviceName('studio.local')).toBe('studio')
    expect(deviceName('MacBook Pro')).toBe('MacBook Pro')
    // Not a suffix — a name that merely contains it keeps every character.
    expect(deviceName('local.thing')).toBe('local.thing')
  })
})

describe('refusals arrive as sentences', () => {
  it('prefers the registry’s own message, verbatim', () => {
    expect(refusalSentence('taken', 'Reserved for a system account.', 'root')).toBe(
      'Reserved for a system account.',
    )
  })

  it('falls back to the copy table when there is no message', () => {
    expect(refusalSentence('taken', undefined, '@anvz')).toBe(takenSentence('anvz'))
    expect(refusalSentence('weak_password')).toBe(ACCOUNT_COPY.PASSWORD_WEAK)
    expect(refusalSentence('offline')).toBe(ACCOUNT_COPY.REGISTRY_DOWN)
    expect(refusalSentence('last_device')).toContain('last device')
  })

  it('never leaks a code to a person', () => {
    for (const reason of ['unknown', 'bad_device', 'rate_limited', 'session-expired'] as const) {
      const sentence = refusalSentence(reason)
      expect(sentence).not.toContain(reason)
      expect(sentence).toMatch(/[.!]$/)
    }
  })
})

describe('the lock screen’s line (D5)', () => {
  it('opens with why it is locked and what kept running', () => {
    expect(lockNote(null)).toBe('Locked while you were away. Your agents kept working.')
  })

  it('counts the tries down in the design’s words', () => {
    expect(lockNote({ ok: false, reason: 'wrong', triesLeft: 4 })).toBe(
      'Not it. 4 tries left before a 1-minute pause.',
    )
    expect(wrongPasswordSentence(1)).toBe('Not it. 1 try left before a 1-minute pause.')
  })

  it('says how long the pause has left', () => {
    expect(lockNote({ ok: false, reason: 'paused', pausedForMs: 60_000 })).toContain('60 seconds')
  })
})

describe('the revoke confirmation names the device and its consequence', () => {
  it('is one sentence, in the table’s words', () => {
    expect(revokeSentence('iPhone')).toBe(
      'The iPhone stops opening this account within a minute. It keeps working on this Wi-Fi until re-paired.',
    )
  })
})

describe('the tabs this phase leaves empty are honest about it', () => {
  it('says No seats yet., not nothing at all', () => {
    expect(ACCOUNT_COPY.NO_SEATS).toBe('No seats yet.')
  })

  it('says what leaves this Mac in the Workspaces tab', () => {
    expect(ACCOUNT_COPY.WORKSPACES_NOTE).toContain('Names and ids only leave this Mac')
  })
})

// ---- phase 4: the badge's producer, the request card and the ladder ----

const NOW = 1_757_000_000_000

const request = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'req-1',
  deviceName: 'Chrome on macOS in Sydney',
  kind: 'browser',
  address: '203.0.113.9',
  at: NOW - 12_000,
  expiresAt: NOW + 120_000,
  ...over,
})

const factorsView = (over: Partial<Parameters<typeof factorRows>[0] & object> = {}): NonNullable<
  Parameters<typeof factorRows>[0]
> => ({
  totp: false,
  passkeys: [],
  mustChangePassword: false,
  registry: 'https://registry.test',
  ...over,
})

describe('the rose badge now has a producer (D1)', () => {
  it('wears the count, and says how many are waiting on hover', () => {
    const view = avatarView(status({ requests: 2 }))
    expect(view.badge).toBe(2)
    expect(view.title).toBe('@drej — 2 devices waiting')
  })

  it('says it in the singular for one, and disappears at zero', () => {
    expect(avatarView(status({ requests: 1 })).title).toBe('@drej — 1 device waiting')
    expect(avatarView(status({ requests: 0 })).badge).toBeNull()
  })
})

describe('the request card, word for word (D6)', () => {
  it('is the design sentence, split into its two lines', () => {
    const view = approvalView(request(), { username: 'drej', hasSecondFactor: false, now: NOW })
    expect(view.lead).toBe('Chrome on macOS in Sydney wants to sign in as @drej.')
    expect(view.detail).toBe(
      'Started 12 seconds ago · 203.0.113.9 · no second factor on the account yet.',
    )
  })

  it('says what NOT ME does before it is done', () => {
    const view = approvalView(request(), { username: 'drej', hasSecondFactor: false, now: NOW })
    expect(view.confirm).toBe(
      'Every other device signs out and you will set a new password.',
    )
  })

  it('drops the factor clause rather than inventing a reassuring one', () => {
    const view = approvalView(request(), { username: 'drej', hasSecondFactor: true, now: NOW })
    expect(view.detail).toBe('Started 12 seconds ago · 203.0.113.9.')
  })

  it('counts in the units a person reads: seconds, then minutes, then hours', () => {
    expect(startedAgo(1_000)).toBe('1 second')
    expect(startedAgo(12_000)).toBe('12 seconds')
    expect(startedAgo(89_000)).toBe('89 seconds')
    expect(startedAgo(120_000)).toBe('2 minutes')
    expect(startedAgo(7_200_000)).toBe('2 hours')
  })
})

describe('the factor ladder, in both states (D3)', () => {
  it('recommends a passkey FIRST while there is none', () => {
    const rows = factorRows(null)
    expect(rows.map((row) => row.factor)).toEqual(['passkey', 'totp'])
    expect(rows[0]).toMatchObject({
      label: 'Add a passkey (Touch ID)',
      state: 'RECOMMENDED',
      action: 'add',
    })
    expect(rows[1]).toMatchObject({ label: 'Add an authenticator app', action: 'add' })
  })

  it('lists EVERY enrolled passkey, keeps ADD beneath, and stops recommending', () => {
    // Real-UI QA: a passkey enrolled in a browser ("Comet on M1Pro") never
    // appeared on the Mac, because the card listed either the keys or the
    // invitation and never both — so the account's only passkey was invisible
    // while the row went on recommending one.
    const rows = factorRows(
      factorsView({
        totp: true,
        passkeys: [
          { id: 'pk-1', name: 'Comet on M1Pro', addedAt: 1_757_116_800_000 },
          { id: 'pk-2', name: 'iPhone', addedAt: 2 },
        ],
      }),
      () => '6 Sept',
    )
    expect(rows.map((row) => row.label)).toEqual([
      'Comet on M1Pro',
      'iPhone',
      'Add a passkey (Touch ID)',
      'Authenticator app',
    ])
    expect(rows[0]).toMatchObject({ state: 'Added 6 Sept', action: 'remove', id: 'pk-1' })
    // Each passkey is removable BY ITS OWN ID, not by position.
    expect(rows[1].id).toBe('pk-2')
    // The invitation stays, unrecommended: the account already has one.
    expect(rows[2]).toMatchObject({ action: 'add', state: '' })
    expect(rows.some((row) => row.state === 'RECOMMENDED')).toBe(false)
  })

  it('recommends the passkey only while the account has none', () => {
    const rows = factorRows(factorsView())
    expect(rows.map((row) => row.action)).toEqual(['add', 'add'])
    expect(rows[0]).toMatchObject({ label: 'Add a passkey (Touch ID)', state: 'RECOMMENDED' })
  })

  it('names the state of a half-enrolled account correctly', () => {
    const rows = factorRows(factorsView({ totp: true }))
    expect(rows[0]).toMatchObject({ state: 'RECOMMENDED', action: 'add' })
    expect(rows[1]).toMatchObject({ label: 'Authenticator app', state: 'ACTIVE', action: 'remove' })
  })
})

describe('after "not me"', () => {
  it('the banner says what happened, not what to do', () => {
    expect(mustChangeBanner(factorsView({ mustChangePassword: true }))).toBe(
      'Set a new password — every other device was signed out.',
    )
  })

  it('is silent in the normal case', () => {
    expect(mustChangeBanner(factorsView())).toBeNull()
    expect(mustChangeBanner(null)).toBeNull()
  })
})

describe('the passkey a desktop cannot make', () => {
  it('offers the browser, at THIS registry, with the design sentence', () => {
    const elsewhere = passkeyElsewhere('https://registry.test')
    expect(elsewhere.note).toBe(
      'Add a passkey on cookrew.dev in your browser — it works from any device',
    )
    expect(elsewhere.url).toBe('https://registry.test/me#security')
  })
})

describe('taking a factor off', () => {
  it('names what is being removed, so the field is not a mystery', () => {
    const [passkey, totp] = factorRows(factorsView({ totp: true, passkeys: [] }))
    expect(removeFactorPrompt(passkey)).toBe('Your password, to remove this passkey')
    expect(removeFactorPrompt(totp)).toBe('Your password, to remove the authenticator')
  })
})

describe('what makes the DEVICES tab re-read itself', () => {
  it('changes when a waiting request is answered', () => {
    // Approving attaches the device at the registry; the count dropping is
    // the moment the list on screen went stale.
    expect(profileKey({ username: 'drej', requests: 1 })).not.toBe(
      profileKey({ username: 'drej', requests: 0 }),
    )
  })

  it('is stable while nothing has happened, so the sheet does not thrash', () => {
    expect(profileKey({ username: 'drej', requests: 0 })).toBe(
      profileKey({ username: 'drej', requests: 0 }),
    )
  })

  it('changes with the account, so a claim redraws the tab', () => {
    expect(profileKey({ username: null, requests: 0 })).not.toBe(
      profileKey({ username: 'drej', requests: 0 }),
    )
  })
})
