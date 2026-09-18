import { describe, expect, it, vi } from 'vitest'
import {
  CARD_BEARER_PATH,
  cardBearerAnswer,
  isCardBearerRequest,
  type CardBearerDeps
} from '../src/main/card-bearer'

/**
 * THE THIRD CALLER'S ONE ROUTE (v3-04c).
 *
 * The card's line runs in its own PTY process and cannot mint a call token —
 * minting needs this Mac's cookrew.dev session, which is the whole account. So
 * it asks here. What this pins is the boundary that makes asking safe: one
 * refusal for every way of not holding the secret, a door name that is checked
 * rather than pasted into a walk, and a refusal that carries the phase so the
 * card can print which of the three failures it was.
 */

const deps = (over: Partial<CardBearerDeps> = {}): CardBearerDeps => ({
  secret: () => 'the-secret',
  bearer: vi.fn(async () => 'door-bearer'),
  account: () => 'drej',
  ...over
})

const ask = (
  over: { authorization?: string; body?: unknown; method?: string; path?: string } = {},
  port = deps()
): ReturnType<typeof cardBearerAnswer> =>
  cardBearerAnswer(port, {
    method: over.method ?? 'POST',
    path: over.path ?? CARD_BEARER_PATH,
    authorization: over.authorization ?? 'Bearer the-secret',
    body: 'body' in over ? over.body : { door: '@mira/alpha' }
  })

describe('which requests this route owns', () => {
  it('is one POST on one path, and every door name begins with @ so it cannot collide', () => {
    expect(isCardBearerRequest('POST', '/bearer')).toBe(true)
    expect(isCardBearerRequest('GET', '/bearer')).toBe(false)
    expect(isCardBearerRequest('POST', '/@mira/alpha/line')).toBe(false)
    expect(CARD_BEARER_PATH.startsWith('@')).toBe(false)
  })
})

describe('the guard', () => {
  it('answers the account’s Bearer to a card that holds the secret', async () => {
    const port = deps()
    await expect(ask({}, port)).resolves.toEqual({
      status: 200,
      body: { token: 'door-bearer', account: 'drej' }
    })
    expect(port.bearer).toHaveBeenCalledWith('@mira/alpha')
  })

  it('refuses every way of not holding it with ONE answer, and never walks', async () => {
    // A caller must not be able to learn whether this Mac has minted a secret
    // yet, or how long one is, from the shape of the refusal.
    const cases: { authorization?: string; port?: CardBearerDeps }[] = [
      { authorization: 'Bearer wrong-secret' },
      { authorization: 'Bearer ' },
      { authorization: 'the-secret' },
      { authorization: '' },
      // A proxy with no account behind it has nothing to mint with.
      { port: deps({ secret: () => null }) },
      // A longer guess and a shorter one answer alike.
      { authorization: 'Bearer the-secret-and-more' },
      { authorization: 'Bearer the' }
    ]
    for (const item of cases) {
      const port = item.port ?? deps()
      const answer = await ask(
        item.authorization === undefined ? {} : { authorization: item.authorization },
        port
      )
      expect(answer, String(item.authorization)).toEqual({
        status: 401,
        body: { error: 'not-this-mac' }
      })
      expect(port.bearer).not.toHaveBeenCalled()
    }
  })
})

describe('the door it is asked about', () => {
  it('is checked before it reaches the walk', async () => {
    for (const door of ['alpha', '@mira', '@mira/alpha/extra', '@Mira/alpha', '', 42, null, undefined]) {
      const port = deps()
      const answer = await ask({ body: { door } }, port)
      expect(answer, String(door)).toEqual({ status: 400, body: { error: 'bad-door' } })
      expect(port.bearer).not.toHaveBeenCalled()
    }
  })

  it('survives a body that is not an object at all', async () => {
    for (const body of [null, 'door', 7, []]) {
      await expect(ask({ body })).resolves.toMatchObject({ status: 400 })
    }
  })
})

describe('a door that will not admit this account', () => {
  it('hands back the phase doorBearer named, so the card can print which refusal it was', async () => {
    const port = deps({
      bearer: vi.fn(async () => {
        throw new Error('@mira/alpha did not admit this account (denied)')
      })
    })
    await expect(ask({}, port)).resolves.toEqual({
      status: 403,
      body: { error: 'refused', message: '@mira/alpha did not admit this account (denied)' }
    })
  })

  it('never falls through to anything else — there is no key path on this route', async () => {
    const port = deps({ bearer: vi.fn(async () => Promise.reject(new Error('offline'))) })
    const answer = await ask({}, port)
    expect(answer.status).toBe(403)
    expect(JSON.stringify(answer.body)).not.toContain('token')
  })
})

describe('a request a page caused', () => {
  it('is refused before the guard is consulted — a card is not a browser', async () => {
    const port = deps()
    const answer = await cardBearerAnswer(port, {
      method: 'POST',
      path: CARD_BEARER_PATH,
      authorization: 'Bearer the-secret',
      origin: 'https://example.test',
      body: { door: '@mira/alpha' }
    })
    expect(answer).toEqual({ status: 401, body: { error: 'not-this-mac' } })
    expect(port.bearer).not.toHaveBeenCalled()
  })
})

describe('a Mac with no account signed in', () => {
  it('answers the Bearer without naming anybody, rather than inventing a name', async () => {
    await expect(ask({}, deps({ account: () => null }))).resolves.toEqual({
      status: 200,
      body: { token: 'door-bearer' }
    })
  })
})
