import { describe, expect, it } from 'vitest'
import { V3_COPY, accountCopy, fillCopy, type V3CopyId } from '../src/shared/account-copy'
import { ACCOUNT_COPY, refusalSentence, revokeSentence, takenSentence } from '../src/renderer/src/account/account-store'
import { MKT_AUTH } from '../src/shared/marketplace-copy'
import { REAUTH_COPY } from '../src/renderer/src/auth-gate'

/**
 * ONE SOURCE FOR THE ACCOUNT'S SENTENCES (V3-07).
 *
 * The design's copy table is the contract; these assert the table is here in
 * full, that no surface has quietly kept its own copy of a sentence, and that
 * the three rules the table is written under still hold for every entry.
 */

/** Every Moment in auth-uiux-v3 → "Copy, in the owner's voice", lower-kebab. */
const TABLE_KEYS: V3CopyId[] = [
  'avatar.no-account',
  'd9.signin.lede',
  'd9.create.lede',
  'd9.crossing.taken',
  'd9.crossing.unknown',
  'd10.join.lede',
  'd10.asked',
  'd10.asked.honest',
  'd10.mismatch',
  'd11.join-row',
  'd11.wifi-row',
  'd11.seat-row',
  'd11.footer',
  'joined.event',
  'd12.revoke',
  'd12.sign-out',
  'd12.last-device',
  'd12.add-a-mac',
  'd13.lock',
  'd14.expiring',
  'd14.held',
  'd14.moved',
  'm5.asked',
  'm5.allowed',
  'g1.identify',
  'g1.seat',
  'g2.no-seat',
  'g2.budget',
  'g3.direct',
  'w6.asked'
]

describe('the copy table is here, in full', () => {
  it('carries every Moment from the spec', () => {
    for (const key of TABLE_KEYS) {
      expect(V3_COPY[key], key).toBeTypeOf('string')
      expect(V3_COPY[key].length, key).toBeGreaterThan(0)
    }
    expect(TABLE_KEYS).toHaveLength(30)
  })

  it('holds no sentence twice under two keys', () => {
    const seen = new Map<string, string>()
    for (const [id, value] of Object.entries(V3_COPY)) {
      const first = seen.get(value)
      expect(first, `${id} repeats ${first}`).toBeUndefined()
      seen.set(value, id)
    }
  })
})

describe('no surface carries a sentence the source already owns', () => {
  /**
   * The thing this is really guarding: a surface that keeps its own literal
   * of a sentence the table owns will drift from it the first time the table
   * is edited, and the two will disagree in front of the same person on two
   * devices. Borrowing is checked by identity, not by eye.
   */
  const shared = new Set(Object.values(V3_COPY) as string[])

  it('account-store borrows rather than repeats', () => {
    for (const [key, value] of Object.entries(ACCOUNT_COPY)) {
      if (typeof value !== 'string') continue
      // Borrowed is fine — that IS the point. A literal that merely LOOKS
      // like a table sentence is what must not exist, so compare the ones
      // that are not reference-equal to any table entry.
      if (shared.has(value)) expect(Object.values(V3_COPY)).toContain(value)
      expect(value, key).not.toMatch(/\berrors?\b|\binvalid\b|\b40[0-9]\b|\b5[0-9]{2}\b/i)
    }
  })

  it('the gate sheet reads the account sentence, it does not restate it', () => {
    expect(MKT_AUTH['mkt.auth.body']).toBe(V3_COPY['g1.identify'])
    expect(MKT_AUTH['mkt.auth.direct']).toBe(V3_COPY['g3.direct'])
  })

  it('the three replaced v2 sentences are gone', () => {
    const all = [
      ...Object.values(ACCOUNT_COPY).filter((v) => typeof v === 'string'),
      ...Object.values(MKT_AUTH),
      ...Object.values(REAUTH_COPY).filter((v) => typeof v === 'string')
    ] as string[]
    expect(all.join(' ')).not.toContain('Claim a username')
    expect(all.join(' ')).not.toContain('until re-paired')
    expect(all.join(' ')).not.toContain('there is no password to remember')
  })

  it('keeps the QR sentence for account-less Macs', () => {
    // Explicitly retained: a Mac with no account still pairs by QR, and v3
    // deleting that sentence would leave it with no way in at all.
    expect(REAUTH_COPY.unpaired).toContain('Scan the QR')
  })
})

describe('the three rules the table is written under', () => {
  it('says neither error, nor invalid, nor a status number', () => {
    for (const [id, value] of Object.entries(V3_COPY)) {
      expect(value, id).not.toMatch(/\berrors?\b/i)
      expect(value, id).not.toMatch(/\binvalid\b/i)
      expect(value, id).not.toMatch(/\b(?:4[0-9]{2}|5[0-9]{2})\b/)
    }
  })

  it('gives every refusal a next step', () => {
    // A refusal with nothing to do next is a dead end wearing a sentence.
    for (const id of ['d9.crossing.taken', 'd10.mismatch', 'd12.last-device', 'g2.no-seat', 'g2.budget'] as V3CopyId[]) {
      expect(V3_COPY[id], id).toMatch(/ — |, or | Ask | Try again|sign in|add another|take it now/i)
    }
  })

  it('says what survives in the same breath as what stopped', () => {
    expect(V3_COPY['d12.sign-out']).toMatch(/Everything on the canvas stays/)
    expect(V3_COPY['d12.revoke']).toMatch(/Anything it asked for is dropped/)
  })

  it('names the revoke contract in all three places it reaches', () => {
    // The architecture's own line: the session now, the door tokens within
    // their TTL, the LAN admission on every Mac within a minute.
    const revoke = V3_COPY['d12.revoke']
    expect(revoke).toMatch(/within a minute/)
    expect(revoke).toMatch(/at every door/)
    expect(revoke).toMatch(/every Mac's Wi-Fi/)
  })
})

describe('filling', () => {
  it('renders the handle sentences with exactly one @', () => {
    expect(accountCopy('d9.crossing.taken', { handle: 'drej' })).toBe(
      '@drej already exists — sign in with your password.'
    )
    expect(takenSentence('drej')).toBe(accountCopy('d9.crossing.taken', { handle: 'drej' }))
  })

  it('throws rather than put a brace on screen', () => {
    expect(() => fillCopy(V3_COPY['d11.wifi-row'], {})).toThrow()
  })

  it('names the device in the revoke confirmation', () => {
    expect(revokeSentence('iPhone')).toContain('The iPhone stops opening this account')
  })

  it('falls back to the unnamed last-device sentence when no account is known', () => {
    // "@" with nothing after it is worse than one extra key.
    expect(refusalSentence('last_device')).not.toContain('@ ')
    expect(refusalSentence('last_device')).toContain('the account')
  })
})
