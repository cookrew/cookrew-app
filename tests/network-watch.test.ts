// THE MAC NOTICES ITS OWN ADDRESSES MOVING.
//
// Every address the companion is reachable on is re-read live by the code
// that serves it, so nothing on this Mac was ever pinned at boot. What WAS
// missing is the moment: the publisher re-read the list on a sixty-second
// clock and nothing else, so a laptop that woke on another Wi-Fi advertised
// the old network for up to a minute — and the phone, told nothing, raced
// the stale names on its own clock on top of that. Restarting the app
// "fixed" it only because a boot publishes at once.
//
// This is the pure part: a set of addresses, read on demand, and ONE event
// when the set differs from the last one seen.

import { describe, expect, it } from 'vitest'
import { createNetworkWatch, type NetworkChange } from '../src/main/network-watch'

const watcher = (reads: (readonly string[] | Error)[], over: { everyMs?: number } = {}) => {
  const changes: NetworkChange[] = []
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  let i = 0
  const watch = createNetworkWatch({
    read: () => {
      const next = reads[Math.min(i, reads.length - 1)]
      i += 1
      if (next instanceof Error) throw next
      return next
    },
    onChange: (change) => changes.push(change),
    setInterval: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return () => void (timer.cleared = true)
    },
    ...over
  })
  return { watch, changes, timers }
}

describe('createNetworkWatch', () => {
  it('the first read seeds the set and says nothing — boot already published', () => {
    const { watch, changes } = watcher([['192.168.2.40']])
    expect(watch.check('boot')).toBe(false)
    expect(changes).toEqual([])
  })

  it('a different set fires ONCE, naming what came and went and why', () => {
    const { watch, changes } = watcher([
      ['192.168.2.40', '100.68.81.64'],
      ['10.0.0.7', '100.68.81.64'],
      ['10.0.0.7', '100.68.81.64']
    ])
    watch.check('boot')
    expect(watch.check('wake')).toBe(true)
    expect(watch.check('poll')).toBe(false)
    expect(changes).toEqual([{ reason: 'wake', added: ['10.0.0.7'], removed: ['192.168.2.40'] }])
  })

  it('the same addresses in another order are the same network', () => {
    const { watch, changes } = watcher([
      ['192.168.2.40', '100.68.81.64'],
      ['100.68.81.64', '192.168.2.40']
    ])
    watch.check('boot')
    expect(watch.check('poll')).toBe(false)
    expect(changes).toEqual([])
  })

  it('losing every address is a change too — the card must stop advertising them', () => {
    const { watch, changes } = watcher([['192.168.2.40'], []])
    watch.check('boot')
    expect(watch.check('poll')).toBe(true)
    expect(changes[0]).toEqual({ reason: 'poll', added: [], removed: ['192.168.2.40'] })
  })

  it('a read that throws is not a network change, and does not forget the last good set', () => {
    const { watch, changes } = watcher([['192.168.2.40'], new Error('ENOBUFS'), ['192.168.2.40']])
    watch.check('boot')
    expect(watch.check('poll')).toBe(false)
    expect(watch.check('poll')).toBe(false)
    expect(changes).toEqual([])
  })

  it('start() polls on its clock and stop() clears it', () => {
    const { watch, changes, timers } = watcher([['a'], ['b']], { everyMs: 1234 })
    const stop = watch.start()
    expect(timers).toHaveLength(1)
    expect(timers[0].ms).toBe(1234)
    // The first tick seeds, the second sees the move.
    timers[0].fn()
    expect(changes).toEqual([])
    timers[0].fn()
    expect(changes).toEqual([{ reason: 'poll', added: ['b'], removed: ['a'] }])
    stop()
    expect(timers[0].cleared).toBe(true)
  })
})
