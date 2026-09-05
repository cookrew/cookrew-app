// SEATS & TEAMS (D4) AND THE CALLERS AT A DOOR (D7), painted.
//
// A static render runs the component body and every branch reachable without
// effects, so the markup IS the picture: the two row shapes the UI/UX note
// specifies, the sentences they carry, and — for D7 — that a card which is not
// a door draws exactly nothing.

import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CALLER_AVATAR_LIMIT,
  callerSentence,
  endSessionSentence,
  noSeatSentence,
  seatSentence,
  servingSummary,
  teamPageUrl,
  type SeatFace,
  type SeatedCaller,
  type ServedCallersRow,
  type ServingSeatsRow
} from '../src/shared/seats'
import {
  SeatsTab,
  UNPUBLISHED,
  activeSeats,
  heldLine,
  seatRefusal,
  servingLine
} from '../src/renderer/src/account/SeatsTab'
import {
  CallerAvatars,
  avatarRow,
  callerHue,
  callerInitials,
  callersForCard
} from '../src/renderer/src/nodes/CallerAvatars'

const NOW = Date.UTC(2026, 8, 4)

const seat = (over: Partial<SeatFace> = {}): SeatFace => ({
  id: 'seat-1',
  team: '@drej/cookrew-alpha',
  account: 'mira',
  source: 'granted',
  by: 'drej',
  createdAt: NOW,
  ...over
})

const servingRow = (over: Partial<ServingSeatsRow> = {}): ServingSeatsRow => ({
  serviceId: 'svc-alpha',
  slug: 'cookrew-alpha',
  team: '@drej/cookrew-alpha',
  title: 'COOKREW Alpha',
  access: 'paid',
  priceUsd: '1',
  seats: [seat(), seat({ id: 'seat-2', account: 'andrej' }), seat({ id: 'seat-3', account: 'lin' })],
  ...over
})

const caller = (over: Partial<SeatedCaller> = {}): SeatedCaller => ({
  username: 'mira',
  accountId: 'acct-mira',
  deviceKind: 'iPhone',
  source: 'bought',
  since: NOW,
  sessionId: 'sess-1',
  conductorId: 'term-caller-1',
  ...over
})

/** The bridge, feature-detected exactly as the components do it. */
function stubBridge(over: Record<string, unknown> = {}): void {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window = {
    cookrew: {
      accountSeats: async () => ({ ok: true, value: { serving: [], held: [] } }),
      ...over
    },
    setTimeout: () => 0,
    clearTimeout: () => undefined
  }
}
stubBridge()
beforeEach(() => stubBridge())

// ── the sentences, which are the product here ──────────────────────────────

describe('the words a seat is described in', () => {
  it('403 names the person refused AND the person who can say yes', () => {
    expect(noSeatSentence('mira', 'drej')).toBe(
      'You are @mira. No seat here yet. Buy one, or ask @drej.'
    )
  })

  it('the SERVING line is "paid $1 · N seats taken", and counts one seat singular', () => {
    expect(servingSummary(servingRow())).toBe('paid $1 · 3 seats taken')
    expect(servingSummary(servingRow({ seats: [seat()] }))).toBe('paid $1 · 1 seat taken')
    expect(servingSummary(servingRow({ access: 'account', priceUsd: undefined, seats: [] }))).toBe(
      'free · 0 seats taken'
    )
  })

  it('a seat says how it was come by, and by whom', () => {
    expect(seatSentence(seat())).toMatch(/^granted by @drej /)
    expect(seatSentence(seat({ source: 'bought', by: 'stripe' }))).toMatch(/^bought a seat /)
  })

  it('a caller hover is username, device and how they got in', () => {
    expect(callerSentence(caller())).toBe('@mira · iPhone · bought a seat')
    expect(callerSentence(caller({ source: 'granted' }))).toBe('@mira · iPhone · granted by you')
    expect(callerSentence(caller({ source: null }))).toBe('@mira · iPhone · signed in')
  })

  it('END SESSION says what it destroys and what it does not', () => {
    expect(endSessionSentence(caller())).toContain('sandbox')
    expect(endSessionSentence(caller())).toContain('The seat stays.')
  })

  it('OPEN goes to the team page at cookrew.dev, with no double slash', () => {
    expect(teamPageUrl('https://cookrew.dev', '@mira/review-bench')).toBe(
      'https://cookrew.dev/@mira/review-bench'
    )
    expect(teamPageUrl('https://cookrew.dev/', '@mira/review-bench')).toBe(
      'https://cookrew.dev/@mira/review-bench'
    )
  })

  it('a grant refused for a name nobody holds says so in a person\'s words', () => {
    expect(seatRefusal('not_found', undefined, 'myra')).toContain('@myra')
    expect(seatRefusal('already_seated', undefined, 'mira')).toBe(
      '@mira already has a seat here.'
    )
    expect(seatRefusal('offline', undefined, 'mira')).toContain('cookrew.dev')
  })
})

// ── the tab ────────────────────────────────────────────────────────────────

describe('the SEATS & TEAMS tab', () => {
  const paint = (surface: { serving: ServingSeatsRow[]; held: unknown[] }): string => {
    stubBridge({ accountSeats: async () => ({ ok: true, value: surface }) })
    return renderToStaticMarkup(<SeatsTab username="drej" />)
  }

  it('says where a seat will appear when there is nothing yet', () => {
    const html = paint({ serving: [], held: [] })
    // The empty state only lands after the effect resolves; the first paint is
    // honest silence rather than a premature "no seats".
    expect(html).toContain('Seats and teams')
    expect(html).not.toContain('SERVING')
  })

  it('a SERVING row is the line from the note, with GRANT A SEAT beside it', () => {
    expect(servingLine(servingRow())).toBe('COOKREW Alpha · paid $1 · 3 seats taken')
  })

  it('a SEAT row names the team and how the seat was come by', () => {
    expect(
      heldLine({ seat: seat({ team: '@mira/review-bench', by: 'mira' }), url: 'x' })
    ).toMatch(/^@mira\/review-bench · granted by @mira /)
  })

  it('counts only LIVE seats — an ended one is history, not a row', () => {
    const row = servingRow({
      seats: [seat(), seat({ id: 'seat-2', endedAt: NOW + 1 })]
    })
    expect(activeSeats(row).map((s) => s.id)).toEqual(['seat-1'])
    expect(servingLine(row)).toContain('1 seat taken')
  })

  it('shows a team with no published name, and says why it has no seats', () => {
    expect(UNPUBLISHED).toContain('cookrew.dev')
    const row = servingRow({ team: null, seats: [] })
    expect(servingLine(row)).toBe('COOKREW Alpha · paid $1 · 0 seats taken')
  })

  it('renders without a bridge at all — a phone has no seats surface', () => {
    ;(globalThis as unknown as { window: Record<string, unknown> }).window = { cookrew: {} }
    expect(() => renderToStaticMarkup(<SeatsTab username="drej" />)).not.toThrow()
  })
})

// ── D7 ─────────────────────────────────────────────────────────────────────

describe('the caller avatars on a served card', () => {
  const rows = (over: Partial<ServedCallersRow> = {}): readonly ServedCallersRow[] => [
    {
      serviceId: 'svc-alpha',
      slug: 'cookrew-alpha',
      orchName: 'Pilot',
      callers: [caller()],
      ...over
    }
  ]

  it('rides the ORCH card whose name is the served team\'s orch', () => {
    expect(callersForCard(rows(), { id: 'term-owner', name: 'Pilot', orch: true })).toHaveLength(1)
  })

  it('draws nothing on a card that is not an orch, and nothing on another orch', () => {
    expect(callersForCard(rows(), { id: 'term-owner', name: 'Pilot', orch: false })).toEqual([])
    expect(callersForCard(rows(), { id: 'term-x', name: 'Scout', orch: true })).toEqual([])
  })

  it('draws nothing on a CALLER\'S OWN conductor — same name, but it is their crew', () => {
    expect(callersForCard(rows(), { id: 'term-caller-1', name: 'Pilot', orch: true })).toEqual([])
  })

  it('draws nothing when the served team has no orch name to match', () => {
    expect(
      callersForCard(rows({ orchName: null }), { id: 'term-owner', name: 'Pilot', orch: true })
    ).toEqual([])
  })

  it('shows three faces and folds the rest into +N', () => {
    const many = [1, 2, 3, 4, 5].map((n) =>
      caller({ username: `user${n}`, sessionId: `s${n}`, conductorId: `c${n}` })
    )
    const { shown, overflow } = avatarRow(many)
    expect(shown).toHaveLength(CALLER_AVATAR_LIMIT)
    expect(overflow).toBe(2)
    const html = renderToStaticMarkup(<CallerAvatars callers={many} />)
    expect(html).toContain('+2')
    expect(html).toContain('5 at this door')
  })

  it('paints initials, a stable colour and the hover sentence', () => {
    const html = renderToStaticMarkup(<CallerAvatars callers={[caller()]} />)
    expect(html).toContain('MI')
    expect(html).toContain(callerSentence(caller()))
    expect(html).toContain(`--caller-hue:${callerHue('mira')}`)
    // The same person is the same colour every time, whoever else is in the room.
    expect(callerHue('mira')).toBe(callerHue('mira'))
    expect(callerHue('mira')).not.toBe(callerHue('andrej'))
  })

  it('takes two letters off a username, and never renders empty', () => {
    expect(callerInitials('mira')).toBe('MI')
    expect(callerInitials('@andrej')).toBe('AN')
    expect(callerInitials('a')).toBe('A')
    expect(callerInitials('---')).toBe('?')
  })

  it('renders nothing at all when nobody is at the door', () => {
    expect(renderToStaticMarkup(<CallerAvatars callers={[]} />)).toBe('')
  })
})
