import { describe, expect, it } from 'vitest'
import { republishDoors, servingChange } from '../src/main/serving-identity'
import { relayHandle } from '../src/main/legacy-identity'

/**
 * THE DOORS FOLLOW THE ACCOUNT — the TRANSITIONS, not the steady state.
 *
 * `relayHandle` is a table and legacy-identity.test.ts already walks every row
 * of it. What was never tested is the thing that was broken: what happens when
 * the answer MOVES. Serving identity was resolved once at module load, so a Mac
 * that booted local-only and then claimed an account kept publishing its doors
 * under the environment's name or its old key's — everything on screen said
 * @magpie while cookrew.dev listed @drej/team, and a seat bought against
 * @magpie/team could not admit anyone at that door.
 *
 * So every case here is a move from one state to another, which is the only
 * kind of case that could have caught this.
 */

const at = (serving: string, over: Partial<Parameters<typeof servingChange>[0]> = {}) =>
  servingChange({ serving, account: null, legacy: null, env: null, ...over })

describe('a Mac with no account claims one', () => {
  it('moves from the environment’s name to the account’s, and republishes', () => {
    // THE REPORTED DEFECT. Boot: no account, COOKREW_HANDLE=drej → doors go up
    // as @drej. The person creates @magpie. Everything on screen says @magpie.
    const change = at('drej', { account: 'magpie', env: 'drej' })
    expect(change.handle).toBe('magpie')
    expect(change.source).toBe('account')
    expect(change.changed).toBe(true)
    expect(change.republish).toBe(true)
  })

  it('moves from nothing to the account’s name, with nothing to republish', () => {
    // A Mac with no account and no COOKREW_HANDLE serves nothing at all, so
    // there is no door listed anywhere to take down and put back.
    const change = at('', { account: 'magpie' })
    expect(change.handle).toBe('magpie')
    expect(change.changed).toBe(true)
    expect(change.republish).toBe(false)
  })

  it('says the environment is being ignored, in relayHandle’s own words', () => {
    const change = at('drej', { account: 'magpie', env: 'drej' })
    expect(change.note).toBe(relayHandle({ account: 'magpie', legacy: null, env: 'drej' }).note)
    expect(change.note).toContain('COOKREW_HANDLE @drej is ignored')
  })
})

describe('a Mac whose key holds another name', () => {
  it('keeps serving as the key, because the key is the only thing it can prove', () => {
    // The deliberate surprise in relayHandle: a v1 door registration is signed
    // with that key, so serving under a name it cannot sign for would refuse
    // the dial rather than rename the door. Re-resolving must not "fix" this.
    const change = at('drej', { account: 'magpie', legacy: 'drej' })
    expect(change.handle).toBe('drej')
    expect(change.source).toBe('legacy')
    expect(change.changed).toBe(false)
    expect(change.republish).toBe(false)
  })

  it('and reports the disagreement rather than hiding it', () => {
    const change = at('drej', { account: 'magpie', legacy: 'drej' })
    expect(change.note).toContain('doors keep publishing as @drej')
  })

  it('a migration makes the two agree, and still moves nothing', () => {
    // After crossing, the account IS the key's handle: same answer, no churn.
    const change = at('drej', { account: 'drej', legacy: 'drej' })
    expect(change.handle).toBe('drej')
    expect(change.changed).toBe(false)
    expect(change.republish).toBe(false)
  })
})

describe('the ordinary case, which is almost every call', () => {
  it('reports no change when the account has not moved', () => {
    // `accounts.onChange` fires on every account write — a profile edit, a
    // renewed session, a device revoked. If this said "changed" for those, the
    // doors would come down and go back up for a display name.
    const change = at('magpie', { account: 'magpie' })
    expect(change.changed).toBe(false)
    expect(change.republish).toBe(false)
  })

  it('treats @Magpie, magpie and " magpie " as the one name', () => {
    for (const account of ['@magpie', 'MAGPIE', ' magpie ']) {
      expect(at('magpie', { account }).changed, account).toBe(false)
    }
  })

  it('answers the same thing twice — nothing here remembers anything', () => {
    const once = at('drej', { account: 'magpie', env: 'drej' })
    const twice = at('drej', { account: 'magpie', env: 'drej' })
    expect(twice).toEqual(once)
  })
})

describe('signing out', () => {
  it('does not take the doors down as a side effect', () => {
    // The account goes and nothing else names this Mac. The doors are now
    // listed under a name it holds no session for — which is worth saying, and
    // is not worth silently disconnecting the callers they are carrying.
    const change = at('magpie', {})
    expect(change.handle).toBe('')
    expect(change.source).toBe('none')
    expect(change.changed).toBe(true)
    expect(change.republish).toBe(false)
  })

  it('falls back to the key when there is one, and republishes onto it', () => {
    // Here there IS a name to serve under, and it is one this Mac can prove.
    const change = at('magpie', { legacy: 'drej' })
    expect(change.handle).toBe('drej')
    expect(change.republish).toBe(true)
  })
})

describe('what it never does', () => {
  it('never contradicts relayHandle — it is that table, asked again', () => {
    const rows = [
      { account: null, legacy: null, env: null },
      { account: null, legacy: null, env: 'drej' },
      { account: null, legacy: 'drej', env: 'other' },
      { account: 'magpie', legacy: null, env: 'drej' },
      { account: 'magpie', legacy: 'drej', env: null },
      { account: 'drej', legacy: 'drej', env: 'drej' },
    ]
    for (const row of rows) {
      const table = relayHandle(row)
      const change = servingChange({ serving: 'whatever', ...row })
      expect(change.handle, JSON.stringify(row)).toBe(table.handle)
      expect(change.source, JSON.stringify(row)).toBe(table.source)
      expect(change.note, JSON.stringify(row)).toBe(table.note)
    }
  })

  it('never asks for a republish it has no name for', () => {
    for (const serving of ['', 'drej', 'magpie']) {
      const change = servingChange({ serving, account: null, legacy: null, env: null })
      expect(change.republish, serving).toBe(false)
    }
  })
})

describe('moving the doors onto the new name', () => {
  const recorder = () => {
    const order: string[] = []
    return {
      order,
      withdraw: async (slug: string) => void order.push(`withdraw:${slug}`),
      serve: async (slug: string) => void order.push(`serve:${slug}`),
    }
  }

  it('withdraws each door before serving it again', async () => {
    // `serve` is idempotent per slug and hands back the door it is already
    // holding — so re-serving without withdrawing changes nothing at all, and
    // is exactly how a fix here could look like it ran.
    const r = recorder()
    const out = await republishDoors({ slugs: () => ['alpha', 'beta'], ...r })
    expect(r.order).toEqual(['withdraw:alpha', 'serve:alpha', 'withdraw:beta', 'serve:beta'])
    expect(out).toEqual({ moved: 2, failed: [] })
  })

  it('moves the rest when one door cannot be re-listed', async () => {
    const order: string[] = []
    const out = await republishDoors({
      slugs: () => ['alpha', 'beta', 'gamma'],
      withdraw: async (slug) => void order.push(`withdraw:${slug}`),
      serve: async (slug) => {
        if (slug === 'beta') throw new Error('cookrew.dev did not answer')
        order.push(`serve:${slug}`)
      },
      log: () => undefined,
    })
    // Stopping at the first failure would leave gamma under the old name with
    // nothing scheduled to try again.
    expect(out.moved).toBe(2)
    expect(out.failed).toEqual(['beta'])
    expect(order).toContain('serve:gamma')
  })

  it('says which door did not move, and does not throw it at the canvas', async () => {
    const said: string[] = []
    await expect(
      republishDoors({
        slugs: () => ['alpha'],
        withdraw: async () => undefined,
        serve: async () => {
          throw new Error('not-listed')
        },
        log: (m) => void said.push(m),
      }),
    ).resolves.toEqual({ moved: 0, failed: ['alpha'] })
    expect(said[0]).toContain('alpha')
    expect(said[0]).toContain('not-listed')
  })

  it('does nothing at all when nothing is served', async () => {
    const r = recorder()
    expect(await republishDoors({ slugs: () => [], ...r })).toEqual({ moved: 0, failed: [] })
    expect(r.order).toEqual([])
  })
})
