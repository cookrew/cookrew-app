import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StarStore } from '../registry/src/stars'

/**
 * STARS — one per account per team, a sort key and nothing more.
 *
 * A star is a fact about a listing, recorded under the account that made it.
 * It never gates, prices or ranks a session; the only thing it may do is order
 * the market. So the store is small: toggle, count, list-by-account, and it
 * survives a restart because a directory that forgot its stars overnight would
 * reshuffle the market every morning.
 */

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'stars-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('a star is one per account per team', () => {
  it('toggles on, then off, and the count follows', () => {
    const stars = new StarStore(dir)
    expect(stars.toggle('mira', 'drej', 'cookrew-alpha')).toEqual({ stars: 1, starred: true })
    expect(stars.count('drej', 'cookrew-alpha')).toBe(1)
    expect(stars.toggle('mira', 'drej', 'cookrew-alpha')).toEqual({ stars: 0, starred: false })
    expect(stars.count('drej', 'cookrew-alpha')).toBe(0)
  })

  it('two accounts are two stars; the same account twice is still one', () => {
    const stars = new StarStore(dir)
    stars.toggle('mira', 'drej', 'cookrew-alpha')
    stars.toggle('ozan', 'drej', 'cookrew-alpha')
    expect(stars.count('drej', 'cookrew-alpha')).toBe(2)
    expect(stars.starred('mira', 'drej', 'cookrew-alpha')).toBe(true)
    expect(stars.starred('lin', 'drej', 'cookrew-alpha')).toBe(false)
  })

  it('lists what one account starred, newest first', () => {
    const stars = new StarStore(dir)
    stars.toggle('mira', 'drej', 'cookrew-alpha')
    stars.toggle('mira', 'sasha', 'review-bench')
    expect(stars.byAccount('mira')).toEqual(['sasha/review-bench', 'drej/cookrew-alpha'])
    expect(stars.byAccount('nobody')).toEqual([])
  })

  it('refuses a malformed account, handle or name', () => {
    const stars = new StarStore(dir)
    expect(stars.toggle('', 'drej', 'cookrew-alpha')).toBeNull()
    expect(stars.toggle('mira', 'Drej', 'cookrew-alpha')).toBeNull()
    expect(stars.toggle('mira', 'drej', '../x')).toBeNull()
    expect(stars.count('drej', 'cookrew-alpha')).toBe(0)
  })
})

describe('stars survive a restart', () => {
  it('writes whole and reads back', () => {
    new StarStore(dir).toggle('mira', 'drej', 'cookrew-alpha')
    const again = new StarStore(dir)
    expect(again.count('drej', 'cookrew-alpha')).toBe(1)
    expect(again.starred('mira', 'drej', 'cookrew-alpha')).toBe(true)
    const raw = JSON.parse(readFileSync(path.join(dir, 'stars.json'), 'utf8'))
    expect(raw).toEqual([{ account: 'mira', team: 'drej/cookrew-alpha', at: expect.any(Number) }])
  })

  it('a torn or absent file is an empty store, not a crash', () => {
    expect(new StarStore(dir).count('drej', 'cookrew-alpha')).toBe(0)
  })
})
