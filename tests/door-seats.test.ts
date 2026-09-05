import { describe, expect, it } from 'vitest'
import {
  DoorCallers,
  DoorSeats,
  seatedCallersFor,
  seatsSurface,
  teamForSlug,
  teamPath,
  type LiveCallerSession,
  type SeatsApi
} from '../src/main/door-seats'
import type { AccountResult } from '../src/shared/account-v2'
import type { SeatFace } from '../src/shared/seats'

/**
 * THE OWNER'S HALF OF THE SEAT CONTRACT — the five routes the desktop speaks
 * with its own session token, and the memory behind D7's caller avatars.
 *
 * The seam is the HTTP call, not the network, so every route's PATH and BODY
 * are asserted here: those are the parts that can drift from the registry
 * silently, and a wrong path is a 404 the surface would show as "no seats".
 */

const TEAM = '@drej/cookrew-alpha'

interface Recorded {
  verb: 'GET' | 'POST' | 'DELETE'
  pathname: string
  body?: unknown
}

function api(answers: Record<string, AccountResult<unknown>> = {}): {
  api: SeatsApi
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const answer = <T,>(pathname: string): AccountResult<T> =>
    (answers[pathname] as AccountResult<T> | undefined) ?? { ok: true, value: {} as T }
  return {
    calls,
    api: {
      get: async (pathname) => {
        calls.push({ verb: 'GET', pathname })
        return answer(pathname)
      },
      post: async (pathname, body) => {
        calls.push({ verb: 'POST', pathname, body })
        return answer(pathname)
      },
      del: async (pathname) => {
        calls.push({ verb: 'DELETE', pathname })
        return answer(pathname)
      }
    }
  }
}

const seat = (over: Partial<SeatFace> = {}): SeatFace => ({
  id: 'seat-1',
  team: TEAM,
  account: 'mira',
  source: 'granted',
  by: 'drej',
  createdAt: 1_800_000_000_000,
  ...over
})

describe('the team address on the wire', () => {
  it('keeps the @ and encodes each half separately', () => {
    expect(teamPath(TEAM)).toBe('/v2/teams/%40drej/cookrew-alpha')
    expect(teamPath('drej/cookrew-alpha')).toBe('/v2/teams/%40drej/cookrew-alpha')
  })

  it('cannot be talked into addressing another route with a smuggled slash', () => {
    // Only the first slash separates; anything after it is one encoded segment.
    expect(teamPath('@drej/a/b')).toBe('/v2/teams/%40drej/a')
  })
})

describe('DoorSeats — the owner-only routes', () => {
  it('lists a team\'s seats at GET /v2/teams/@o/t/seats', async () => {
    const { api: seam, calls } = api({
      '/v2/teams/%40drej/cookrew-alpha/seats': { ok: true, value: { seats: [seat()] } }
    })
    const result = await new DoorSeats(seam).forTeam(TEAM)
    expect(result).toEqual({ ok: true, value: [seat()] })
    expect(calls).toEqual([{ verb: 'GET', pathname: '/v2/teams/%40drej/cookrew-alpha/seats' }])
  })

  it('lists what this account holds elsewhere at GET /v2/me/seats', async () => {
    const { api: seam, calls } = api({
      '/v2/me/seats': { ok: true, value: { seats: [seat({ team: '@mira/review-bench' })] } }
    })
    const result = await new DoorSeats(seam).mine()
    expect(result.ok && result.value[0].team).toBe('@mira/review-bench')
    expect(calls[0].pathname).toBe('/v2/me/seats')
  })

  it('grants by username, normalised — @Mira and "mira " are one person', async () => {
    const { api: seam, calls } = api({
      '/v2/teams/%40drej/cookrew-alpha/seats': { ok: true, value: { seat: seat() } }
    })
    await new DoorSeats(seam).grant(TEAM, '  @Mira ')
    expect(calls[0]).toEqual({
      verb: 'POST',
      pathname: '/v2/teams/%40drej/cookrew-alpha/seats',
      body: { username: 'mira' }
    })
  })

  it('ends a seat by id, encoded', async () => {
    const { api: seam, calls } = api()
    await new DoorSeats(seam).end(TEAM, 'seat 1/2')
    expect(calls[0]).toEqual({
      verb: 'DELETE',
      pathname: '/v2/teams/%40drej/cookrew-alpha/seats/seat%201%2F2'
    })
  })

  it('settles a purchase as bought, never as a grant', async () => {
    const { api: seam, calls } = api({
      '/v2/teams/%40drej/cookrew-alpha/seats/settle': {
        ok: true,
        value: { seat: seat({ source: 'bought' }) }
      }
    })
    const result = await new DoorSeats(seam).settle(TEAM, {
      username: 'mira',
      by: 'stripe',
      receipt: 'cs_1'
    })
    expect(result).toEqual({ ok: true, value: seat({ source: 'bought' }) })
    expect(calls[0].body).toEqual({
      username: 'mira',
      source: 'bought',
      by: 'stripe',
      receipt: 'cs_1'
    })
  })

  it('carries a refusal through rather than inventing an empty answer', async () => {
    const { api: seam } = api({
      '/v2/teams/%40drej/cookrew-alpha/seats': { ok: false, reason: 'session-expired' }
    })
    await expect(new DoorSeats(seam).forTeam(TEAM)).resolves.toEqual({
      ok: false,
      reason: 'session-expired'
    })
  })

  it('reads a body with no seats as no seats, not as a failure', async () => {
    const { api: seam } = api()
    await expect(new DoorSeats(seam).forTeam(TEAM)).resolves.toEqual({ ok: true, value: [] })
  })

  it('refuses to report a grant the registry answered without a seat in it', async () => {
    const { api: seam } = api()
    await expect(new DoorSeats(seam).grant(TEAM, 'mira')).resolves.toEqual({
      ok: false,
      reason: 'unknown'
    })
  })
})

describe('the callers at the door — D7\'s data', () => {
  const session = (over: Partial<LiveCallerSession> = {}): LiveCallerSession => ({
    serviceId: 'svc-alpha',
    sessionId: 'sess-1',
    caller: 'acct-mira',
    conductorId: 'term-1',
    openedAt: 1_000,
    ...over
  })

  it('names a caller from what the sign-in said, with the seat source resolved', () => {
    const callers = new DoorCallers()
    callers.seated({
      serviceId: 'svc-alpha',
      sub: 'acct-mira',
      username: 'mira',
      dev: 'dev-phone',
      seat: 'seat-1'
    })
    expect(seatedCallersFor('svc-alpha', [session()], callers, [seat({ source: 'bought' })])).toEqual(
      [
        {
          username: 'mira',
          accountId: 'acct-mira',
          deviceKind: 'device',
          source: 'bought',
          since: 1_000,
          sessionId: 'sess-1',
          conductorId: 'term-1'
        }
      ]
    )
  })

  it('leaves out a key-based caller — there is no username to draw', () => {
    expect(seatedCallersFor('svc-alpha', [session({ caller: 'ana' })], new DoorCallers())).toEqual([])
  })

  it('leaves out a name we remember for somebody who is not connected', () => {
    const callers = new DoorCallers()
    callers.seated({
      serviceId: 'svc-alpha',
      sub: 'acct-mira',
      username: 'mira',
      dev: 'd',
      seat: null
    })
    expect(seatedCallersFor('svc-alpha', [], callers)).toEqual([])
  })

  it('never mixes two services', () => {
    const callers = new DoorCallers()
    callers.seated({ serviceId: 'svc-alpha', sub: 'acct-mira', username: 'mira', dev: 'd', seat: null })
    callers.seated({ serviceId: 'svc-beta', sub: 'acct-lin', username: 'lin', dev: 'd', seat: null })
    const rows = seatedCallersFor(
      'svc-alpha',
      [session(), session({ serviceId: 'svc-beta', caller: 'acct-lin', sessionId: 'sess-2' })],
      callers
    )
    expect(rows.map((r) => r.username)).toEqual(['mira'])
  })

  it('reports a seat we cannot find in the list as an UNKNOWN source, not a guess', () => {
    const callers = new DoorCallers()
    callers.seated({
      serviceId: 'svc-alpha',
      sub: 'acct-mira',
      username: 'mira',
      dev: 'd',
      seat: 'seat-gone'
    })
    expect(seatedCallersFor('svc-alpha', [session()], callers, [])[0].source).toBeNull()
  })

  it('a second sign-in replaces the first — the newest token is the current truth', () => {
    const callers = new DoorCallers()
    callers.seated({ serviceId: 'svc-alpha', sub: 'acct-mira', username: 'mira', dev: 'd1', seat: null })
    callers.seated({ serviceId: 'svc-alpha', sub: 'acct-mira', username: 'mira', dev: 'd2', seat: 's1' })
    expect(callers.get('svc-alpha', 'acct-mira')).toMatchObject({ dev: 'd2', seat: 's1' })
    callers.forget('svc-alpha', 'acct-mira')
    expect(callers.get('svc-alpha', 'acct-mira')).toBeNull()
  })

  it('orders by arrival, so the row does not reshuffle under the owner', () => {
    const callers = new DoorCallers()
    for (const [sub, name] of [
      ['acct-lin', 'lin'],
      ['acct-mira', 'mira']
    ]) {
      callers.seated({ serviceId: 'svc-alpha', sub, username: name, dev: 'd', seat: null })
    }
    const rows = seatedCallersFor(
      'svc-alpha',
      [
        session({ caller: 'acct-mira', openedAt: 20, sessionId: 's-b' }),
        session({ caller: 'acct-lin', openedAt: 10, sessionId: 's-a' })
      ],
      callers
    )
    expect(rows.map((r) => r.username)).toEqual(['lin', 'mira'])
  })
})

describe('when a caller arrived', () => {
  it('keeps the FIRST sign-in time across a token refresh', () => {
    let clock = 100
    const callers = new DoorCallers(() => clock)
    const entry = {
      serviceId: 'svc-alpha',
      sub: 'acct-mira',
      username: 'mira',
      dev: 'd1',
      seat: null
    }
    callers.seated(entry)
    clock = 900
    callers.seated({ ...entry, dev: 'd2' })
    expect(callers.since('svc-alpha', 'acct-mira')).toBe(100)
    expect(callers.get('svc-alpha', 'acct-mira')?.dev).toBe('d2')
  })

  it('knows nothing about a caller it has not seen', () => {
    expect(new DoorCallers().since('svc-alpha', 'acct-nobody')).toBeNull()
  })
})

describe('the whole SEATS & TEAMS surface, in one ask', () => {
  const team = {
    serviceId: 'svc-alpha',
    slug: 'cookrew-alpha',
    team: TEAM,
    title: 'COOKREW Alpha',
    access: 'paid' as const,
    priceUsd: '1'
  }

  it('pairs each served team with its seats, and lists what this account holds', async () => {
    const { api: seam } = api({
      '/v2/teams/%40drej/cookrew-alpha/seats': { ok: true, value: { seats: [seat()] } },
      '/v2/me/seats': { ok: true, value: { seats: [seat({ id: 's9', team: '@mira/bench' })] } }
    })
    const surface = await seatsSurface({
      seats: new DoorSeats(seam),
      serving: () => [team],
      origin: 'https://cookrew.dev'
    })
    expect(surface.serving).toEqual([{ ...team, seats: [seat()] }])
    expect(surface.held).toEqual([
      { seat: seat({ id: 's9', team: '@mira/bench' }), url: 'https://cookrew.dev/@mira/bench' }
    ])
  })

  it('KEEPS THE ROW when the registry will not answer, and carries the reason', async () => {
    const { api: seam } = api({
      '/v2/teams/%40drej/cookrew-alpha/seats': { ok: false, reason: 'offline' },
      '/v2/me/seats': { ok: false, reason: 'offline' }
    })
    const surface = await seatsSurface({
      seats: new DoorSeats(seam),
      serving: () => [team],
      origin: 'https://cookrew.dev'
    })
    expect(surface.serving).toEqual([{ ...team, seats: [], error: 'offline' }])
    expect(surface.held).toEqual([])
  })

  it('never asks about a team with no published name — it can hold no seats', async () => {
    const { api: seam, calls } = api()
    const surface = await seatsSurface({
      seats: new DoorSeats(seam),
      serving: () => [{ ...team, team: null }],
      origin: 'https://cookrew.dev'
    })
    expect(surface.serving[0].seats).toEqual([])
    expect(calls.map((c) => c.pathname)).toEqual(['/v2/me/seats'])
  })

  it('leaves an ENDED seat out of the held rows — it has nothing to open', async () => {
    const { api: seam } = api({
      '/v2/me/seats': {
        ok: true,
        value: { seats: [seat({ id: 's1', endedAt: 1 }), seat({ id: 's2', team: '@mira/bench' })] }
      }
    })
    const surface = await seatsSurface({
      seats: new DoorSeats(seam),
      serving: () => [],
      origin: 'https://cookrew.dev'
    })
    expect(surface.held.map((row) => row.seat.id)).toEqual(['s2'])
  })

  it('a desktop with no account still lists what it is serving', async () => {
    const surface = await seatsSurface({
      seats: null,
      serving: () => [team],
      origin: 'https://cookrew.dev'
    })
    expect(surface.serving).toEqual([{ ...team, seats: [] }])
    expect(surface.held).toEqual([])
  })

  it('resolves a slug to the team it publishes as, and nothing else', () => {
    expect(teamForSlug([team], 'cookrew-alpha')).toBe(TEAM)
    expect(teamForSlug([team], 'other')).toBeNull()
    expect(teamForSlug([{ ...team, team: null }], 'cookrew-alpha')).toBeNull()
  })
})
