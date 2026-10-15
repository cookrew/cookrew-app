import { describe, expect, it } from 'vitest'
import { createInboxFeed, enterDuringHold, holdsInbox } from '../src/renderer/src/command-box-feed'
import type { Decision } from '../src/main/sous-control'

// ROUND 2, items 3 and 4: the box holds the inbox open only while it can be
// seen, with one paired subscription; Enter during a hold commits the same
// sentence and resubmits a changed one.

describe('holdsInbox', () => {
  it('holds only while the desktop box is open, and always on the phone bar', () => {
    expect(holdsInbox({ open: false, phone: false })).toBe(false)
    expect(holdsInbox({ open: true, phone: false })).toBe(true)
    expect(holdsInbox({ open: false, phone: true })).toBe(false)
  })
})

describe('createInboxFeed — subscribe and unsubscribe are paired', () => {
  it('attaches once, delivers rows while attached, and unsubscribes exactly once on detach', () => {
    let subs = 0
    let unsubs = 0
    let push: (rows: unknown[]) => void = () => undefined
    const got: unknown[][] = []
    const feed = createInboxFeed(
      {
        onInbox: (cb) => {
          subs += 1
          push = cb
          return () => {
            unsubs += 1
          }
        }
      },
      (rows) => got.push(rows)
    )
    feed.attach()
    feed.attach()
    expect(subs).toBe(1)
    push([1])
    expect(got).toEqual([[1]])
    feed.detach()
    feed.detach()
    expect(unsubs).toBe(1)
    push([2])
    expect(got).toEqual([[1]])
    // open again → a fresh pair
    feed.attach()
    expect(subs).toBe(2)
    feed.detach()
    expect(unsubs).toBe(2)
  })

  it('a bridge with no subscription reads once', async () => {
    let reads = 0
    const got: unknown[][] = []
    const feed = createInboxFeed({ inbox: () => (reads += 1, Promise.resolve([7])) }, (rows) => got.push(rows))
    feed.attach()
    await Promise.resolve()
    expect(reads).toBe(1)
    expect(got).toEqual([[7]])
  })
})

describe('enterDuringHold', () => {
  const decision = { kind: 'ask', target: { id: 'forge', name: 'Forge' }, alternates: [], reasons: [], token: 't', holdMs: 1500, sentence: 'Make the install section of README English' } as unknown as Decision
  it('the same sentence commits; a changed one cancels the hold and resubmits', () => {
    expect(enterDuringHold('Make the install section of README English', decision)).toBe('commit')
    expect(enterDuringHold('  Make the install section of README English ', decision)).toBe('commit')
    expect(enterDuringHold('Make the install section of README English and add a test', decision)).toBe('resubmit')
    expect(enterDuringHold('', decision)).toBe('resubmit')
  })
})
