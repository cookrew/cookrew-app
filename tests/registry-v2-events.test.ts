import { describe, expect, it } from 'vitest'
import { V2Events, type EventKind } from '../registry/src/v2-events'

/**
 * THE FEED'S BOUNDED TAIL, AND WHAT MAY BE PUSHED OUT OF IT (H5).
 *
 * account:changed is the only channel this design has for telling an owner
 * that something happened to their account — there is no email. Its tail is
 * bounded, so the question "which kind gives way when it is full" decides
 * whether the feed still works at the moment it matters, which is while
 * somebody is attacking the account.
 *
 * The seat route's own flood is closed twice over next door (the dedupe and a
 * limiter), and this is the third line: even a DISTRIBUTED ask — a hundred
 * different accounts each asking once, every one of them a genuine arrival —
 * must not be able to evict a revoke. What is asserted here is the rule that
 * makes that true, held without a registry.
 */

const CAP = 100

const feed = (): V2Events => new V2Events(() => 1_800_000_000_000)

const fill = (events: V2Events, kind: EventKind, n: number, who = 'drej'): void => {
  for (let i = 0; i < n; i += 1) events.append(who, { kind, address: `@a/${i}` })
}

const kinds = (events: V2Events, who = 'drej'): EventKind[] =>
  events.since(who, 0).events.map((event) => event.kind)

describe('the tail is bounded', () => {
  it('holds at the cap however much arrives', () => {
    const events = feed()
    fill(events, 'request', CAP * 3)
    expect(events.held('drej')).toBe(CAP)
  })

  it('bounds each account on its own — one account cannot spend another’s room', () => {
    const events = feed()
    fill(events, 'request', CAP * 2, 'drej')
    events.append('mira', { kind: 'revoked', device: 'iPhone' })
    expect(events.held('drej')).toBe(CAP)
    expect(kinds(events, 'mira')).toEqual(['revoked'])
  })
})

describe('what a flood may push out', () => {
  it('a hundred arrivals do NOT evict the owner’s revoke', () => {
    // The distributed case the limiter and the dedupe cannot reach: every one
    // of these is a different guest asking once, so every one is a genuine
    // thing that happened — and the owner still has to be able to see the
    // revoke underneath them.
    const events = feed()
    events.append('drej', { kind: 'revoked', device: 'iPhone' })
    fill(events, 'request', CAP * 2)
    expect(events.held('drej')).toBe(CAP)
    expect(kinds(events)).toContain('revoked')
    // And it is still the OLDEST, so its position in the story is unchanged.
    expect(kinds(events)[0]).toBe('revoked')
  })

  it('keeps every kind an account’s own ceremonies cause, under any flood', () => {
    const events = feed()
    const owned: EventKind[] = ['joined', 'revoked', 'password-changed', 'not-me', 'door-moved']
    for (const kind of owned) events.append('drej', { kind })
    fill(events, 'request', CAP * 5)
    expect(events.held('drej')).toBe(CAP)
    for (const kind of owned) expect(kinds(events), kind).toContain(kind)
  })

  it('drops the OLDEST arrivals first, so the newest asks are the ones kept', () => {
    const events = feed()
    events.append('drej', { kind: 'revoked' })
    fill(events, 'request', CAP + 50)
    const held = events.since('drej', 0).events
    // The revoke, then the last 99 asks: nothing in the middle survives ahead
    // of something newer.
    expect(held).toHaveLength(CAP)
    expect(held[0].kind).toBe('revoked')
    expect(held[1].address).toBe('@a/51')
    expect(held[held.length - 1].address).toBe(`@a/${CAP + 49}`)
  })

  it('a tail that is ALL reserved still holds at the cap, oldest first out', () => {
    // The one case with nothing better to do: an account cannot grow this
    // without bound by having a great deal happen to it.
    const events = feed()
    for (let i = 0; i < CAP + 10; i += 1) events.append('drej', { kind: 'joined', device: `mac-${i}` })
    const held = events.since('drej', 0).events
    expect(held).toHaveLength(CAP)
    expect(held[0].device).toBe('mac-10')
  })
})

describe('the cursor still means what it meant', () => {
  it('never goes backwards, and never re-reads an event a client has seen', () => {
    const events = feed()
    events.append('drej', { kind: 'revoked' })
    const first = events.since('drej', 0)
    expect(first.events).toHaveLength(1)
    fill(events, 'request', CAP * 2)
    const next = events.since('drej', first.cursor)
    // Everything after the revoke, and the revoke itself is not repeated.
    expect(next.events.every((event) => event.seq > first.cursor)).toBe(true)
    expect(next.events.some((event) => event.kind === 'revoked')).toBe(false)
    expect(next.cursor).toBeGreaterThan(first.cursor)
  })

  it('stays in seq order after a trim that kept an old event and dropped newer ones', () => {
    const events = feed()
    events.append('drej', { kind: 'not-me' })
    fill(events, 'request', CAP * 2)
    const held = events.since('drej', 0).events
    for (let i = 1; i < held.length; i += 1) {
      expect(held[i].seq, `${i}`).toBeGreaterThan(held[i - 1].seq)
    }
  })
})

describe('the live push', () => {
  it('announces every event, including one the tail will not keep', () => {
    // The push is what a device holding a link hears NOW; the tail is what one
    // that was asleep catches up on. Trimming the second must not silence the
    // first.
    const events = feed()
    const heard: EventKind[] = []
    const off = events.subscribe((_who, event) => void heard.push(event.kind))
    fill(events, 'request', CAP + 5)
    expect(heard).toHaveLength(CAP + 5)
    off()
    events.append('drej', { kind: 'revoked' })
    expect(heard).toHaveLength(CAP + 5)
  })
})
