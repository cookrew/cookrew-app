import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { SEATS_FILE, V2Seats, teamAddress } from '../registry/src/v2-seats'

/**
 * SEATS — THE STORE'S RULES.
 *
 * A seat is a fact at the registry: this account may open that team's door.
 * The rules it has to keep are few and each one is a way the product would
 * otherwise lie — two active seats for one person would double-charge them,
 * a seat that survived its ending would keep a revoked guest in the room, and
 * a file read as half-written would read as "nobody is seated anywhere".
 */

const TEAM = teamAddress('drej', 'alpha')
const OTHER = teamAddress('drej', 'beta')

const dirs: string[] = []
const fresh = (): { dir: string; seats: V2Seats; now: () => number } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'v2-seats-'))
  dirs.push(dir)
  let clock = 1_757_000_000_000
  const now = (): number => clock
  return { dir, seats: new V2Seats(dir, now), now: () => (clock += 1000) }
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const granted = (seats: V2Seats, account: string, team = TEAM) =>
  seats.grant({ team, account, by: 'drej' })

describe('a granted seat', () => {
  it('is an active fact naming the team, the account and who gave it', () => {
    const { seats } = fresh()
    const out = granted(seats, 'mira')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.seat).toMatchObject({ team: TEAM, account: 'mira', source: 'granted', by: 'drej' })
    expect(out.seat.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(out.seat.endedAt).toBeUndefined()
    expect(seats.activeFor(TEAM, 'mira')?.id).toBe(out.seat.id)
  })

  it('is one per team and account — a second grant is refused, not duplicated', () => {
    const { seats } = fresh()
    expect(granted(seats, 'mira').ok).toBe(true)
    const again = granted(seats, 'mira')
    expect(again).toEqual({ ok: false, reason: 'already_seated' })
    expect(seats.forTeam(TEAM)).toHaveLength(1)
  })

  it('does not stop the same person being seated at another team', () => {
    const { seats } = fresh()
    expect(granted(seats, 'mira').ok).toBe(true)
    expect(granted(seats, 'mira', OTHER).ok).toBe(true)
    expect(seats.activeFor(OTHER, 'mira')).not.toBeNull()
  })

  it('finds the account whatever case or @ it is written with', () => {
    const { seats } = fresh()
    expect(seats.grant({ team: '@DREJ/Alpha', account: '@Mira', by: '@Drej' }).ok).toBe(true)
    expect(seats.activeFor(TEAM, 'mira')).not.toBeNull()
    expect(seats.activeFor(TEAM, 'mira')?.by).toBe('drej')
  })
})

describe('a bought seat', () => {
  it('records the rail that settled it and the receipt the door reported', () => {
    const { seats } = fresh()
    const out = seats.settle({ team: TEAM, account: 'mira', by: 'stripe', receipt: 'cs_test_123' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.seat).toMatchObject({ source: 'bought', by: 'stripe', receipt: 'cs_test_123' })
  })

  it('refuses a rail that is not one the door can settle on', () => {
    const { seats } = fresh()
    expect(seats.settle({ team: TEAM, account: 'mira', by: 'paypal' as never, receipt: 'x' })).toEqual({
      ok: false,
      reason: 'bad_seat'
    })
  })

  it('refuses a receipt longer than the line a door is allowed to report', () => {
    const { seats } = fresh()
    const out = seats.settle({ team: TEAM, account: 'mira', by: 'x402', receipt: 'r'.repeat(513) })
    expect(out).toEqual({ ok: false, reason: 'bad_seat' })
  })

  it('is refused while a granted seat is still active — one seat, one person', () => {
    const { seats } = fresh()
    expect(granted(seats, 'mira').ok).toBe(true)
    expect(seats.settle({ team: TEAM, account: 'mira', by: 'stripe', receipt: 'r' })).toEqual({
      ok: false,
      reason: 'already_seated'
    })
  })
})

describe('ending a seat', () => {
  it('marks it ended rather than forgetting it, and frees the account to be seated again', () => {
    const { seats, now } = fresh()
    const first = granted(seats, 'mira')
    if (!first.ok) throw new Error('grant failed')
    now()
    const ended = seats.end(TEAM, first.seat.id)
    expect(ended.ok).toBe(true)
    expect(seats.activeFor(TEAM, 'mira')).toBeNull()
    expect(seats.forTeam(TEAM)[0].endedAt).toBeGreaterThan(first.seat.createdAt)
    expect(granted(seats, 'mira').ok).toBe(true)
    expect(seats.forTeam(TEAM)).toHaveLength(2)
  })

  it('answers not_found for a seat of another team, so an id is not a key on its own', () => {
    const { seats } = fresh()
    const out = granted(seats, 'mira')
    if (!out.ok) throw new Error('grant failed')
    expect(seats.end(OTHER, out.seat.id)).toEqual({ ok: false, reason: 'not_found' })
    expect(seats.end(TEAM, 'not-a-seat')).toEqual({ ok: false, reason: 'not_found' })
  })

  it('is idempotent in effect: ending an ended seat is not found', () => {
    const { seats } = fresh()
    const out = granted(seats, 'mira')
    if (!out.ok) throw new Error('grant failed')
    expect(seats.end(TEAM, out.seat.id).ok).toBe(true)
    expect(seats.end(TEAM, out.seat.id)).toEqual({ ok: false, reason: 'not_found' })
  })
})

describe('what a seat expires into', () => {
  it('stops being active the moment its expiry passes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'v2-seats-'))
    dirs.push(dir)
    let clock = 1_000
    const seats = new V2Seats(dir, () => clock)
    const out = seats.grant({ team: TEAM, account: 'mira', by: 'drej', expiresAt: 2_000 })
    expect(out.ok).toBe(true)
    expect(seats.activeFor(TEAM, 'mira')).not.toBeNull()
    clock = 2_001
    expect(seats.activeFor(TEAM, 'mira')).toBeNull()
    // And the account may be seated again without ending anything by hand.
    expect(seats.grant({ team: TEAM, account: 'mira', by: 'drej' }).ok).toBe(true)
  })
})

describe('what the store can be asked', () => {
  it('lists an account’s seats, active first', () => {
    const { seats, now } = fresh()
    const gone = granted(seats, 'mira')
    if (!gone.ok) throw new Error('grant failed')
    now()
    seats.end(TEAM, gone.seat.id)
    now()
    const live = granted(seats, 'mira', OTHER)
    if (!live.ok) throw new Error('grant failed')
    const held = seats.heldBy('mira')
    expect(held).toHaveLength(2)
    expect(held[0].id).toBe(live.seat.id)
    expect(held[1].endedAt).toBeDefined()
  })

  it('names who else is seated, once each, and never someone whose seat ended', () => {
    const { seats } = fresh()
    granted(seats, 'mira')
    granted(seats, 'lin')
    const andrej = granted(seats, 'andrej')
    if (!andrej.ok) throw new Error('grant failed')
    seats.end(TEAM, andrej.seat.id)
    expect(seats.seatedAt(TEAM)).toEqual(['lin', 'mira'])
  })

  it('refuses a team that is not an address and an account that is not a username', () => {
    const { seats } = fresh()
    expect(seats.grant({ team: 'alpha', account: 'mira', by: 'drej' })).toEqual({ ok: false, reason: 'bad_seat' })
    expect(seats.grant({ team: TEAM, account: 'Mira Smith', by: 'drej' })).toEqual({ ok: false, reason: 'bad_seat' })
    expect(seats.grant({ team: TEAM, account: 'mira', by: '' })).toEqual({ ok: false, reason: 'bad_seat' })
  })
})

describe('the file under it', () => {
  it('survives a restart, is written whole, and is readable by nobody else', () => {
    const { dir, seats } = fresh()
    granted(seats, 'mira')
    const file = path.join(dir, SEATS_FILE)
    expect(existsSync(file)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // Temp file then rename: nothing is left behind for a reader to trip on.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp'))).toEqual([])
    const reopened = new V2Seats(dir)
    expect(reopened.activeFor(TEAM, 'mira')?.account).toBe('mira')
  })

  it('refuses to start on a torn file, and says which file and what to do', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'v2-seats-'))
    dirs.push(dir)
    writeFileSync(path.join(dir, SEATS_FILE), '{"version":2,"seats":[{"id":"x"')
    expect(() => new V2Seats(dir)).toThrow(/refusing to start/)
    expect(() => new V2Seats(dir)).toThrow(new RegExp(SEATS_FILE))
    expect(() => new V2Seats(dir)).toThrow(/restore it from a backup/)
  })

  it('refuses a file whose seats are not seats, rather than reading them as none', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'v2-seats-'))
    dirs.push(dir)
    writeFileSync(path.join(dir, SEATS_FILE), JSON.stringify({ version: 2, seats: [{ id: 'x' }] }))
    expect(() => new V2Seats(dir)).toThrow(/refusing to start/)
  })
})

/**
 * THE CAP, AND WHOSE SEAT IT MAY NOT TAKE (security review, LOW).
 *
 * The file is bounded so it always loads. It used to be bounded by insertion
 * order — `slice(-SEATS_MAX)` — which drops the OLDEST rows, and the oldest
 * rows are the long-standing paid seats. A person who bought a seat a year
 * ago would have arrived at the door a stranger, with nothing anywhere saying
 * why. History is what gets trimmed now; a live seat never is.
 */
describe('the seat file’s cap', () => {
  const CAP = 20_000
  const seed = (live: number, ended: number): { dir: string; said: string[] } => {
    const dir = mkdtempSync(path.join(tmpdir(), 'v2-seats-cap-'))
    dirs.push(dir)
    const seats = [
      ...Array.from({ length: live }, (_, at) => ({
        id: `live-${at}`,
        team: TEAM,
        account: `holder${at}`,
        source: 'bought',
        by: 'stripe',
        createdAt: 1_700_000_000_000 + at
      })),
      ...Array.from({ length: ended }, (_, at) => ({
        id: `ended-${at}`,
        team: OTHER,
        account: `past${at}`,
        source: 'granted',
        by: 'drej',
        createdAt: 1_700_000_000_000 + at,
        endedAt: 1_700_000_100_000 + at
      }))
    ]
    writeFileSync(path.join(dir, SEATS_FILE), JSON.stringify({ version: 2, seats }))
    return { dir, said: [] }
  }

  it('drops the oldest ENDED seat to make room, and never a live one', () => {
    const { dir } = seed(1, CAP - 1)
    const seats = new V2Seats(dir, () => 1_757_000_000_000)
    expect(granted(seats, 'newcomer', OTHER).ok).toBe(true)

    const kept = new V2Seats(dir, () => 1_757_000_000_000)
    expect(kept.forTeam(TEAM).map((seat) => seat.id)).toEqual(['live-0'])
    const history = kept.forTeam(OTHER)
    expect(history).toHaveLength(CAP - 1)
    // The oldest ended row made way; the newest ones and the new seat stayed.
    expect(history.some((seat) => seat.id === 'ended-0')).toBe(false)
    expect(history.some((seat) => seat.account === 'newcomer')).toBe(true)
  })

  it('keeps every live seat past the cap and says so, rather than revoking one silently', () => {
    const { dir } = seed(CAP, 0)
    const said: string[] = []
    const seats = new V2Seats(dir, () => 1_757_000_000_000, (line) => said.push(line))
    expect(granted(seats, 'newcomer', OTHER).ok).toBe(true)

    const kept = new V2Seats(dir, () => 1_757_000_000_000)
    expect(kept.forTeam(TEAM)).toHaveLength(CAP)
    expect(kept.activeFor(TEAM, 'holder0')).not.toBeNull()
    expect(said).toHaveLength(1)
    expect(said[0]).toContain('20001 seats are live')
    expect(said[0]).toMatch(/[.!]$/)
  })
})
