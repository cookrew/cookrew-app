import { describe, expect, it } from 'vitest'
import { cardFace, readerLine, seatAt, shelfOf, standingAt } from '../registry/src/market-shelf'
import type { ListedDoor } from '../registry/src/site'
import type { V2Seat } from '../registry/src/v2-seats'

/**
 * THE MARKET AS ONE ACCOUNT SEES IT.
 *
 * One username decides what every card is to the reader and the one button
 * it wears. These are the rules a shop must get right before any page is
 * drawn: what is mine goes first, a seat is mine on the name it was bought
 * under, and a stranger is offered the sheet — never a handle to enrol.
 */
const door = (over: Partial<ListedDoor> = {}): ListedDoor => ({
  handle: 'drej',
  name: 'alpha',
  title: 'COOKREW Alpha',
  door: 'Pilot',
  agents: 3,
  address: 'https://cookrew.dev/@drej/alpha',
  transport: 'relay',
  access: 'paid',
  priceUsd: '1',
  rails: ['stripe'],
  seenAt: 1,
  ...over
})
const seat = (over: Partial<V2Seat> = {}): V2Seat => ({
  id: 'seat-1',
  team: '@drej/alpha',
  account: 'mira',
  source: 'bought',
  by: 'stripe',
  createdAt: Date.UTC(2026, 9, 2),
  ...over
})
const alpha = door()
const ledger = door({ name: 'ledger', title: 'Ledger Room', priceUsd: '4.50' })
const free = door({ handle: 'lin', name: 'open-house', title: 'Open House', access: 'account', priceUsd: undefined, rails: [] })
const mine = door({ handle: 'mira', name: 'atelier', title: 'Atelier' })

describe('what a door is to a reader', () => {
  it('is decided by the username and the seats held under it', () => {
    expect(standingAt(alpha, null, []).kind).toBe('stranger')
    expect(standingAt(alpha, 'mira', []).kind).toBe('unseated')
    expect(standingAt(alpha, 'mira', [seat()]).kind).toBe('seated')
    expect(standingAt(free, 'mira', []).kind).toBe('admitted')
    expect(standingAt(mine, 'mira', []).kind).toBe('owner')
  })

  it('an ended or expired seat holds nothing', () => {
    const now = Date.UTC(2026, 9, 4)
    expect(seatAt(alpha, [seat({ endedAt: now - 1 })], now)).toBeNull()
    expect(seatAt(alpha, [seat({ expiresAt: now - 1 })], now)).toBeNull()
    expect(seatAt(alpha, [seat({ expiresAt: now + 1 })], now)).not.toBeNull()
    // A seat at another team is not a seat here.
    expect(seatAt(ledger, [seat()], now)).toBeNull()
  })
})

describe('the one chip and the one button', () => {
  it('offers a stranger the sheet, priced or free — never a handle', () => {
    const priced = cardFace({ kind: 'stranger' }, alpha)
    expect(priced.primary).toEqual({ label: 'Sign in to buy · $1', signin: true })
    expect(priced.chip.label).toBe('1 USD · a seat, once')
    expect(cardFace({ kind: 'stranger' }, free).primary).toEqual({ label: 'Sign in to open', signin: true })
  })

  it('sends an unseated reader to buy, and says the owner can be asked', () => {
    const face = cardFace({ kind: 'unseated', account: 'mira', price: '1' }, alpha)
    expect(face.primary).toEqual({ label: 'Buy a seat · $1', href: '/drej/alpha?buy=1' })
    expect(face.note).toContain('ask @drej')
  })

  it('opens for the owner, the seated and the admitted, and names how the seat came', () => {
    expect(cardFace({ kind: 'owner', account: 'drej' }, alpha).primary).toEqual({ label: 'Open', href: '/drej/alpha' })
    const bought = cardFace({ kind: 'seated', account: 'mira', since: seat().createdAt }, alpha, seat())
    expect(bought.chip.label).toBe('Seated · bought')
    expect(bought.primary.href).toBe('/drej/alpha')
    const granted = cardFace({ kind: 'seated', account: 'mira', since: 1 }, alpha, seat({ source: 'granted', by: 'drej' }))
    expect(granted.chip.label).toBe('Seated · granted by @drej')
    expect(cardFace({ kind: 'admitted', account: 'mira' }, free).chip.label).toBe('Free · yours to open')
  })
})

describe('the shelf', () => {
  const doors = [alpha, ledger, free, mine]

  it('is empty for a stranger and for a reader who holds nothing', () => {
    expect(shelfOf(doors, null, []).yours).toEqual([])
    expect(shelfOf(doors, 'ozan', []).yours).toEqual([])
    expect(shelfOf(doors, 'ozan', []).rest).toHaveLength(4)
  })

  it('puts the teams you serve first, then your seats newest first, and nothing twice', () => {
    const seats = [seat({ createdAt: 10 }), seat({ id: 'seat-2', team: '@drej/ledger', createdAt: 20 })]
    const shelf = shelfOf(doors, 'mira', seats)
    expect(shelf.yours.map((d) => d.title)).toEqual(['Atelier', 'Ledger Room', 'COOKREW Alpha'])
    expect(shelf.rest.map((d) => d.title)).toEqual(['Open House'])
    expect(shelf.standing.get('lin/open-house')?.kind).toBe('admitted')
  })

  it('reads the account back in one line', () => {
    const shelf = shelfOf(doors, 'mira', [seat()])
    expect(readerLine('mira', shelf, 3)).toBe('@mira · 1 seat · 1 team served · 3 starred')
    expect(readerLine('ozan', shelfOf(doors, 'ozan', []), 0)).toBe('@ozan · 0 seats · 0 starred')
  })
})
