import { describe, expect, it } from 'vitest'
import { coalesceInput, staleInput, stripStale, BRIDGE_INPUT_STALE_MS } from '../src/renderer/src/path/bridge-outbox'

const j = (o: object): string => JSON.stringify(o)

describe('what a slow line may fold together', () => {
  it('keeps only the newest move and touchmove: a position is absolute', () => {
    expect(coalesceInput(j({ t: 'move', x: 1, y: 1 }), j({ t: 'move', x: 2, y: 2 }))).toBe(j({ t: 'move', x: 2, y: 2 }))
    const a = j({ t: 'touchmove', x: 1, y: 1 })
    const b = j({ t: 'touchmove', x: 9, y: 9 })
    expect(coalesceInput(a, b)).toBe(b)
  })

  it('never folds two fingers into one, or a move across a press', () => {
    const one = j({ t: 'touchmove', x: 1, y: 1 })
    const two = j({ t: 'touchmove', points: [{ id: 0, x: 1, y: 1 }, { id: 1, x: 2, y: 2 }] })
    expect(coalesceInput(one, two)).toBeNull()
    expect(coalesceInput(j({ t: 'down', x: 1, y: 1 }), j({ t: 'move', x: 2, y: 2 }))).toBeNull()
    expect(coalesceInput(j({ t: 'move', x: 1, y: 1 }), j({ t: 'up', x: 2, y: 2 }))).toBeNull()
  })

  it('keeps a button change apart: a drag is not a hover', () => {
    expect(coalesceInput(j({ t: 'move', x: 1, y: 1 }), j({ t: 'move', x: 2, y: 2, buttons: 1 }))).toBeNull()
  })

  it('adds wheel deltas and multiplies pinches, so no distance is lost', () => {
    const wheel = JSON.parse(coalesceInput(j({ t: 'wheel', x: 1, y: 1, dy: 10, dx: 2 }), j({ t: 'wheel', x: 5, y: 5, dy: 7 })) as string)
    expect(wheel).toMatchObject({ t: 'wheel', x: 5, y: 5, dy: 17, dx: 2 })
    const pinch = JSON.parse(coalesceInput(j({ t: 'pinch', x: 1, y: 1, scale: 2 }), j({ t: 'pinch', x: 3, y: 3, scale: 1.5 })) as string)
    expect(pinch).toMatchObject({ t: 'pinch', x: 3, y: 3, scale: 3 })
  })

  it('a modifier starts a new wheel, and keys never fold', () => {
    expect(coalesceInput(j({ t: 'wheel', x: 1, y: 1, dy: 1 }), j({ t: 'wheel', x: 1, y: 1, dy: 1, mods: 8 }))).toBeNull()
    expect(coalesceInput(j({ t: 'key', key: 'a' }), j({ t: 'key', key: 'b' }))).toBeNull()
  })

  it('only the newest IME composition matters', () => {
    expect(coalesceInput(j({ t: 'compose', text: 'n' }), j({ t: 'compose', text: 'ni' }))).toBe(j({ t: 'compose', text: 'ni' }))
  })

  it('leaves anything it cannot read alone', () => {
    expect(coalesceInput('nonsense', j({ t: 'move', x: 1, y: 1 }))).toBeNull()
  })
})

describe('what is too old to send after a dropped line', () => {
  const at = 10_000
  const old = at - BRIDGE_INPUT_STALE_MS - 1

  it('drops a press on a page that has moved on', () => {
    for (const t of ['tap', 'down', 'move', 'wheel', 'pinch', 'touchstart', 'touchmove']) {
      expect(staleInput(j({ t }), old, at), t).toBe(true)
    }
  })

  it('keeps what was typed, and every release, or a finger stays down in Chrome', () => {
    for (const t of ['key', 'text', 'paste', 'compose', 'up', 'touchend', 'touchcancel', 'claim', 'offer']) {
      expect(staleInput(j({ t }), old, at), t).toBe(false)
    }
  })

  it('a fresh press goes', () => {
    expect(staleInput(j({ t: 'tap' }), at - 100, at)).toBe(false)
  })

  it('blanks a stale item in a batch without moving the sequence numbers', () => {
    const batch = [{ text: j({ t: 'key', key: 'a' }), at: old }, { text: j({ t: 'tap' }), at: old }]
    expect(stripStale(batch, { now: at }).items.map((item) => item.text)).toEqual([j({ t: 'key', key: 'a' }), ''])
  })

  it('does not type into a field the tap never reached', () => {
    const batch = [
      { text: j({ t: 'tap' }), at: old },
      { text: j({ t: 'key', key: 'p' }), at: old },
      { text: j({ t: 'text', text: 'secret' }), at: at },
      { text: j({ t: 'touchend' }), at: old }
    ]
    const { items, keysHeld } = stripStale(batch, { now: at })
    expect(items.map((item) => item.text)).toEqual(['', '', '', j({ t: 'touchend' })])
    expect(keysHeld).toBe(true)
  })

  it('a fresh press lets typing go again', () => {
    const batch = [{ text: j({ t: 'tap' }), at }, { text: j({ t: 'key', key: 'p' }), at }]
    const { items, keysHeld } = stripStale(batch, { now: at, keysHeld: true })
    expect(items.map((item) => item.text)).toEqual(batch.map((item) => item.text))
    expect(keysHeld).toBe(false)
  })

  it('a press made on a picture the line had already stopped updating is stale whatever its age', () => {
    const batch = [{ text: j({ t: 'tap' }), at: at - 100 }]
    expect(stripStale(batch, { now: at, heardAt: at - 2000 }).items[0].text).toBe('')
    expect(stripStale(batch, { now: at, heardAt: at - 500 }).items[0].text).not.toBe('')
  })
})
