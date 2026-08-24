import { describe, expect, it, vi } from 'vitest'
import { KeyedStore } from '../src/renderer/src/keyed-store'

describe('KeyedStore — per-key subscription (the canvas re-render fix)', () => {
  it('notifies ONLY the changed key, not other keys', () => {
    const store = new KeyedStore<number>()
    const a = vi.fn()
    const b = vi.fn()
    store.subscribeKey('a', a)
    store.subscribeKey('b', b)

    store.set('a', 1)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled() // key b's card must not re-render

    store.set('b', 2)
    expect(a).toHaveBeenCalledTimes(1) // still 1 — a did not re-render
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('does not notify when the value is identical (===)', () => {
    const store = new KeyedStore<{ v: number }>()
    const cb = vi.fn()
    const obj = { v: 1 }
    store.set('a', obj)
    store.subscribeKey('a', cb)
    store.set('a', obj) // same reference
    expect(cb).not.toHaveBeenCalled()
  })

  it('the global subscription fires on any key change', () => {
    const store = new KeyedStore<number>()
    const global = vi.fn()
    store.subscribeGlobal(global)
    store.set('a', 1)
    store.set('b', 2)
    expect(global).toHaveBeenCalledTimes(2)
  })

  it('getSnapshot is stable until a real change (new identity only when changed)', () => {
    const store = new KeyedStore<number>()
    store.set('a', 1)
    const s1 = store.getSnapshot()
    const s2 = store.getSnapshot()
    expect(s1).toBe(s2) // no change between reads → same object
    store.set('b', 2)
    const s3 = store.getSnapshot()
    expect(s3).not.toBe(s1) // changed → new identity (so global readers update)
    expect(s3).toEqual({ a: 1, b: 2 })
  })

  it('get returns the stored value by reference (per-key read is cheap)', () => {
    const store = new KeyedStore<{ v: number }>()
    const obj = { v: 5 }
    store.set('a', obj)
    expect(store.get('a')).toBe(obj)
    expect(store.get('missing')).toBeUndefined()
  })

  it('seed prefers existing entries — a live event is not clobbered by a stale snapshot', () => {
    const store = new KeyedStore<string>()
    store.set('a', 'live') // a fresh live event arrived first
    store.seed(
      [
        ['a', 'stale'],
        ['b', 'snapshot']
      ],
      true
    )
    expect(store.get('a')).toBe('live') // not overwritten
    expect(store.get('b')).toBe('snapshot') // new key seeded
  })

  it('clear removes everything and runs onRemove per value (blob revoke)', () => {
    const store = new KeyedStore<string>()
    store.set('a', 'blob:one')
    store.set('b', 'blob:two')
    const revoked: string[] = []
    store.clear((v) => revoked.push(v))
    expect(store.get('a')).toBeUndefined()
    expect(store.get('b')).toBeUndefined()
    expect(revoked.sort()).toEqual(['blob:one', 'blob:two'])
    expect(store.getSnapshot()).toEqual({})
  })

  it('unsubscribe stops notifications', () => {
    const store = new KeyedStore<number>()
    const cb = vi.fn()
    const off = store.subscribeKey('a', cb)
    store.set('a', 1)
    off()
    store.set('a', 2)
    expect(cb).toHaveBeenCalledTimes(1) // only the pre-unsubscribe change
  })
})
