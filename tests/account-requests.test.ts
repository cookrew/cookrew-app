import { describe, expect, it } from 'vitest'
import { V3_COPY } from '../src/shared/account-copy'
import {
  ACCOUNT_EVENT_PLAIN,
  KEEP_ANSWERED_MS,
  REQUEST_COPY,
  answeredRowView,
  badgeCount,
  eventNotice,
  isMatchComplete,
  keptAnswered,
  pendingRowView,
  queueEmpty,
  queueFooter,
  queueView,
  reachSealInfo,
  rowInitials,
  rowNotice,
  type AccountEvent,
  type AnsweredRow,
  type QueueRow,
} from '../src/shared/account-requests'

/**
 * THE ONE QUEUE'S DECISIONS (D11), held without a window.
 *
 * Every choice the card makes — which sentence a row reads, which buttons it
 * offers, whether APPROVE can fire, what the badge counts, when a finished row
 * falls off — is a pure function here, so the component is left with nothing to
 * decide and these can be checked exactly. The sentences are asserted by
 * IDENTITY against the copy table rather than by eye: a row that merely looked
 * right would drift the first time the table is edited.
 */

const NOW = 1_800_000_000_000
const MINUTE = 60_000
const AT = NOW - 4 * MINUTE
const INPUT = { username: 'drej', now: NOW }

const join: QueueRow = {
  id: 'j1',
  kind: 'join',
  device: 'Mac Studio',
  address: 'Shanghai',
  at: AT,
  expiresAt: NOW + MINUTE,
  state: 'pending',
}
const reach: QueueRow = {
  id: 'r1',
  kind: 'reach',
  device: 'iPhone',
  address: 'iPhone',
  at: AT,
  expiresAt: NOW + MINUTE,
  state: 'pending',
  askKey: { kty: 'OKP', crv: 'Ed25519', x: 'abc' },
}
const seat: QueueRow = {
  id: 's1',
  kind: 'seat',
  account: 'jkim',
  team: '@mira/research-crew',
  address: 'jkim',
  at: AT,
  expiresAt: NOW + MINUTE,
  state: 'pending',
}

describe('a waiting row, by kind', () => {
  it('a join asks for the number, and APPROVE cannot fire until it is filled', () => {
    const view = pendingRowView(join, INPUT)
    expect(view.lead).toBe('Mac Studio wants to join @drej')
    expect(view.matchLabel).toBe(V3_COPY['d11.join-row'])
    expect(view.actions.map((a) => a.id)).toEqual(['approve', 'deny', 'not-me'])
    // The rung is worth nothing if the button can be pressed without reading
    // the other screen, so the flag is on the model and not in the component.
    expect(view.actions[0].needsMatch).toBe(true)
    expect(view.actions.filter((a) => a.needsMatch === true)).toHaveLength(1)
    expect(view.chip).toBeNull()
  })

  it('a reach is one tap, and reads the table sentence about what ALLOW hands over', () => {
    const view = pendingRowView(reach, INPUT)
    // The lead is the table's first sentence, filled: the second half of that
    // entry explains what ALLOW hands over and is said once, in the footer.
    expect(view.lead).toBe('iPhone wants to reach this Mac on Wi-Fi.')
    expect(V3_COPY['d11.wifi-row'].startsWith('{device} wants to reach this Mac on Wi-Fi.')).toBe(true)
    expect(view.actions.map((a) => a.id)).toEqual(['allow', 'not-now'])
    expect(view.matchLabel).toBeNull()
    // The clause that makes ALLOW considerable: this is not a stranger.
    expect(view.detail).toContain(REQUEST_COPY.ON_ACCOUNT)
  })

  it('a seat names both the guest and the room, and is answered by two buttons', () => {
    const view = pendingRowView(seat, INPUT)
    expect(view.lead).toBe('@jkim asks for a seat at @mira/research-crew.')
    expect(view.actions.map((a) => a.id)).toEqual(['seat-them', 'decline'])
    expect(view.initials).toBe('JK')
  })

  it('every row ends with how long it has been asking', () => {
    for (const row of [join, reach, seat]) {
      expect(pendingRowView(row, INPUT).detail, row.kind).toMatch(/4 minutes ago$/)
    }
  })

  it('never invents a fact the wire did not carry', () => {
    // The design's mock shows "$4 team · 3 seated" and a device kind; the
    // queue's shape carries neither, so the row says less rather than guessing.
    const view = pendingRowView(seat, INPUT)
    expect(view.detail).not.toMatch(/\$/)
    expect(view.detail).not.toMatch(/seated/)
  })
})

describe('a row that is over', () => {
  const answered = (over: Partial<AnsweredRow>): AnsweredRow => ({
    id: 'a1',
    kind: 'join',
    outcome: 'joined',
    subject: 'Mac Studio',
    at: AT,
    ...over,
  })

  it('wears the chip its outcome earned, and says so in the first person', () => {
    const cases: [AnsweredRow, string, string][] = [
      [answered({}), REQUEST_COPY.CHIP_DONE, REQUEST_COPY.OVER_APPROVED],
      [answered({ kind: 'reach', outcome: 'allowed', subject: 'iPhone' }), REQUEST_COPY.CHIP_LAN, REQUEST_COPY.OVER_ALLOWED],
      [
        answered({ kind: 'seat', outcome: 'seated', subject: 'jkim', team: '@mira/research-crew' }),
        REQUEST_COPY.CHIP_SEATED,
        REQUEST_COPY.OVER_SEATED,
      ],
      [answered({ outcome: 'denied', subject: 'iPhone' }), REQUEST_COPY.CHIP_NOT_ME, REQUEST_COPY.OVER_DENIED],
    ]
    for (const [row, chip, clause] of cases) {
      const view = answeredRowView(row, INPUT)
      expect(view.chip, row.outcome).toBe(chip)
      expect(view.detail, row.outcome).toContain(clause)
      // Nothing to press: the moment is past.
      expect(view.actions, row.outcome).toEqual([])
      expect(view.matchLabel, row.outcome).toBeNull()
    }
  })

  it('reads the table sentence for each of the four states', () => {
    expect(answeredRowView(answered({}), INPUT).lead).toBe('Mac Studio joined @drej')
    expect(answeredRowView(answered({ kind: 'reach', outcome: 'allowed', subject: 'iPhone' }), INPUT).lead).toBe(
      'iPhone can reach this Mac on Wi-Fi',
    )
    expect(
      answeredRowView(answered({ kind: 'seat', outcome: 'seated', subject: 'jkim', team: 'RESEARCH CREW' }), INPUT).lead,
    ).toBe('@jkim is seated at RESEARCH CREW')
    expect(answeredRowView(answered({ outcome: 'denied', subject: 'iPhone' }), INPUT).lead).toBe(
      'A sign-in as @drej was denied on iPhone',
    )
  })

  it('falls off after seven days, and not a moment before', () => {
    const rows: AnsweredRow[] = [
      answered({ id: 'fresh', at: NOW - KEEP_ANSWERED_MS + MINUTE }),
      answered({ id: 'stale', at: NOW - KEEP_ANSWERED_MS - MINUTE }),
    ]
    expect(keptAnswered(rows, NOW).map((r) => r.id)).toEqual(['fresh'])
  })
})

describe('the card as a whole', () => {
  it('puts every question above every receipt', () => {
    const old: AnsweredRow = { id: 'a1', kind: 'join', outcome: 'joined', subject: 'Mac Studio', at: NOW - MINUTE }
    // The receipt is NEWER than the question, and still sorts below it: the
    // list exists to be answered.
    const view = queueView([join], [old], INPUT)
    expect(view.map((r) => r.id)).toEqual(['j1', 'a1'])
    expect(view[0].chip).toBeNull()
    expect(view[1].chip).toBe(REQUEST_COPY.CHIP_DONE)
  })

  it('orders each half newest first', () => {
    const older: QueueRow = { ...seat, id: 's0', at: AT - MINUTE }
    expect(queueView([older, join], [], INPUT).map((r) => r.id)).toEqual(['j1', 's0'])
  })

  it('counts every kind on the badge, and no finished row', () => {
    expect(badgeCount([join, reach, seat])).toBe(3)
    expect(badgeCount([])).toBe(0)
  })

  it('borrows its footer and its empty state from the table', () => {
    expect(queueFooter()).toBe(V3_COPY['d11.footer'])
    expect(queueEmpty()).toBe(V3_COPY['d11.empty'])
  })
})

describe('initials', () => {
  it('takes two words as two capitals and one word as it is written', () => {
    expect(rowInitials('Mac Studio')).toBe('MS')
    // "iP", not "IP": it is how the phone writes itself.
    expect(rowInitials('iPhone')).toBe('iP')
    // A person is raised, a machine keeps its own case.
    expect(rowInitials('@jkim')).toBe('JK')
    expect(rowInitials('jkim')).toBe('jk')
  })

  it('survives a name nobody sent', () => {
    expect(rowInitials('')).toBe('??')
    expect(rowInitials('  ')).toBe('??')
    expect(rowInitials('X')).toBe('X')
  })
})

describe('the number', () => {
  it('is two digits with no leading zero, as the asking device shows it', () => {
    expect(isMatchComplete('42')).toBe(true)
    expect(isMatchComplete(' 42 ')).toBe(true)
    for (const bad of ['4', '420', '07', '', 'ab', '4a']) expect(isMatchComplete(bad), bad).toBe(false)
  })
})

describe('what a device is told', () => {
  const event = (over: Partial<AccountEvent>): AccountEvent => ({
    seq: 1,
    kind: 'joined',
    device: 'Mac Studio',
    at: AT,
    ...over,
  })

  it('has a sentence for every kind, and borrows five of the six', () => {
    expect(eventNotice(event({}), 'drej')).toBe('Mac Studio joined @drej')
    const revoke = eventNotice(event({ kind: 'revoked', device: 'iPhone' }), 'drej')
    // The LEAD of the table's revoke sentence, asserted by identity rather
    // than by eye: its second half answers a question nobody is asking once
    // the device is already gone.
    expect(V3_COPY['d12.revoke'].replace('{device}', 'iPhone').startsWith(revoke)).toBe(true)
    expect(revoke).toContain('stops opening this account within a minute')
    expect(revoke).not.toContain('Anything it asked for is dropped')
    expect(eventNotice(event({ kind: 'password-changed' }), 'drej')).toBe(
      ACCOUNT_EVENT_PLAIN.passwordChanged,
    )
    expect(eventNotice(event({ kind: 'door-moved', address: 'alpha' }), 'drej')).toBe(
      'alpha moved to Mac Studio. This Mac stopped serving it.',
    )
    expect(eventNotice(event({ kind: 'not-me', device: undefined }), 'drej')).toBe(
      `A sign-in as @drej was denied on ${ACCOUNT_EVENT_PLAIN.anotherDevice}`,
    )
    expect(eventNotice(event({ kind: 'request' }), 'drej')).toBe(ACCOUNT_EVENT_PLAIN.request)
  })

  it('announces an arriving row as the row itself reads', () => {
    expect(rowNotice(join, 'drej')).toBe('Mac Studio wants to join @drej')
    expect(rowNotice(seat, 'drej')).toBe('@jkim asks for a seat at @mira/research-crew.')
  })

  it('never says error, invalid, or a status number', () => {
    const said = [
      ...Object.values(ACCOUNT_EVENT_PLAIN),
      ...Object.values(REQUEST_COPY),
      eventNotice(event({}), 'drej'),
      pendingRowView(join, INPUT).lead,
    ].join(' ')
    expect(said).not.toMatch(/\berrors?\b|\binvalid\b|\b[45][0-9]{2}\b/i)
  })
})

describe('the seal label', () => {
  it('is the request id, so both sides derive it from the one fact they share', () => {
    expect(reachSealInfo('r1')).toBe('reach:r1')
  })
})
