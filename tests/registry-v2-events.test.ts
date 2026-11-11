import { describe, expect, it } from 'vitest'
import { V2Events, type EventKind } from '../registry/src/v2-events'

/**
 * THE FEED'S BOUNDED TAIL, AND WHO CAN FILL IT (H5).
 *
 * account:changed is the only channel this design has for telling an owner
 * that something happened to their account — there is no email. Its tail is
 * bounded, so the question "what can push a revoke out of it" decides
 * whether the feed still works at the moment it matters, which is while
 * somebody is attacking the account.
 *
 * The answer is: only the account's own ceremonies. The one kind a stranger
 * could cause (`request`, a guest asking for a seat) gave way first when the
 * tail was full; the ask is gone (0.6.0) and the kind with it, so the tail is
 * plainly oldest first. That a stranger's ask appends nothing is held over
 * HTTP in tests/registry-v2-requests-http.test.ts.
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
    fill(events, 'joined', CAP * 3)
    expect(events.held('drej')).toBe(CAP)
  })

  it('bounds each account on its own — one account cannot spend another’s room', () => {
    const events = feed()
    fill(events, 'joined', CAP * 2, 'drej')
    events.append('mira', { kind: 'revoked', device: 'iPhone' })
    expect(events.held('drej')).toBe(CAP)
    expect(kinds(events, 'mira')).toEqual(['revoked'])
  })
})

describe('what falls off a full tail', () => {
  it('has no kind a party outside the account can append', () => {
    // Held as a list a reader can check against the type: every kind here is
    // caused by the account's own ceremonies or one of its own Macs. A kind a
    // stranger can cause must not join it without a rule that makes it give
    // way first (v2-events.ts · trimmed).
    const owned: Record<EventKind, true> = {
      joined: true,
      revoked: true,
      'password-changed': true,
      'door-moved': true,
      'not-me': true,
      linked: true,
      unlinked: true
    }
    const events = feed()
    for (const kind of Object.keys(owned) as EventKind[]) events.append('drej', { kind })
    expect(kinds(events)).toEqual(Object.keys(owned))
    expect(Object.keys(owned)).not.toContain('request')
  })

  it('the oldest, whatever their kind, and never anything newer than what is kept', () => {
    const events = feed()
    events.append('drej', { kind: 'revoked' })
    fill(events, 'joined', CAP + 50)
    const held = events.since('drej', 0).events
    expect(held).toHaveLength(CAP)
    // The last hundred, in order: nothing in the middle survives ahead of something newer.
    expect(held[0].address).toBe('@a/50')
    expect(held[held.length - 1].address).toBe(`@a/${CAP + 49}`)
    expect(held.some((event) => event.kind === 'revoked')).toBe(false)
  })

  it('an account cannot grow it without bound by having a great deal happen to it', () => {
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
    fill(events, 'joined', CAP * 2)
    const next = events.since('drej', first.cursor)
    // Everything after the revoke, and the revoke itself is not repeated.
    expect(next.events.every((event) => event.seq > first.cursor)).toBe(true)
    expect(next.events.some((event) => event.kind === 'revoked')).toBe(false)
    expect(next.cursor).toBeGreaterThan(first.cursor)
  })

  it('stays in seq order after a trim', () => {
    const events = feed()
    events.append('drej', { kind: 'not-me' })
    fill(events, 'joined', CAP * 2)
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
    fill(events, 'joined', CAP + 5)
    expect(heard).toHaveLength(CAP + 5)
    off()
    events.append('drej', { kind: 'revoked' })
    expect(heard).toHaveLength(CAP + 5)
  })
})
