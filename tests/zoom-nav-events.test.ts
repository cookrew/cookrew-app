// HOW PEOPLE MOVE THROUGH THE VIEWS, COUNTED ON THIS MACHINE (owner,
// 2026-11-17; renderer nav-events.ts): closed sets only, counts per day in the
// page's storage, nothing sent anywhere.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bareWindow } from './support/memory-storage'
import { KEEP_DAYS, NAV_STORAGE_KEY, countNav, navKey, readNavEvent, type NavEvent } from '../src/renderer/src/nav-events'

const OPEN: NavEvent = { name: 'full_open', kind: 'agent', from: 'artifacts' }
const BACK: NavEvent = { name: 'full_back', kind: 'item', to: 'agent-full', by: 'esc', previous: true }
const LEAVE: NavEvent = { name: 'full_leave', kind: 'agent', to: 'devices' }

describe('what an event may carry', () => {
  it('takes the three shapes as they are', () => {
    for (const event of [OPEN, BACK, LEAVE]) expect(readNavEvent(event)).toEqual(event)
  })

  it('refuses a name, a title, an id or one field too many', () => {
    expect(readNavEvent({ ...OPEN, id: 'term-1' })).toBeNull()
    expect(readNavEvent({ ...OPEN, from: 'Velvet' })).toBeNull()
    expect(readNavEvent({ ...BACK, by: 'swipe' })).toBeNull()
    expect(readNavEvent({ ...BACK, previous: 'yes' })).toBeNull()
    expect(readNavEvent({ ...LEAVE, kind: 'terminal' })).toBeNull()
    expect(readNavEvent({ name: 'page_view', kind: 'agent', to: 'devices' })).toBeNull()
    expect(readNavEvent(null)).toBeNull()
    expect(readNavEvent([OPEN])).toBeNull()
  })

  it('sends nothing: no fetch, no bridge, no registry in the module', () => {
    const source = readFileSync('src/renderer/src/nav-events.ts', 'utf8')
    expect(source).not.toMatch(/fetch\(|cookrew\(\)|XMLHttpRequest|sendBeacon|WebSocket/)
  })
})

describe('the counts', () => {
  it('are one row per shape, per day', () => {
    const once = countNav({}, BACK, '2026-11-17')
    const twice = countNav(once, BACK, '2026-11-17')
    expect(twice).toEqual({ '2026-11-17': { [navKey(BACK)]: 2 } })
    expect(navKey(BACK)).toBe('full_back item to=agent-full by=esc previous')
    expect(once).toEqual({ '2026-11-17': { [navKey(BACK)]: 1 } })
  })

  it(`keep the last ${KEEP_DAYS} days`, () => {
    let counts = {}
    for (let d = 1; d <= KEEP_DAYS + 3; d += 1) counts = countNav(counts, OPEN, `2026-10-${String(d).padStart(2, '0')}`)
    const days = Object.keys(counts).sort()
    expect(days).toHaveLength(KEEP_DAYS)
    expect(days[0]).toBe('2026-10-04')
  })
})

describe('tracking', () => {
  let storage: Storage

  beforeEach(() => {
    vi.resetModules()
    const page = bareWindow('http://127.0.0.1:5173/')
    storage = page.localStorage as Storage
    vi.stubGlobal('window', page)
    vi.stubGlobal('localStorage', storage)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('counts in the page’s storage, keeps the recent ones and tells who listens', async () => {
    const nav = await import('../src/renderer/src/nav-events')
    const heard: NavEvent[] = []
    const off = nav.subscribeNav((e) => heard.push(e))
    nav.trackNav(OPEN, Date.UTC(2026, 10, 17, 12))
    nav.trackNav(OPEN, Date.UTC(2026, 10, 17, 13))
    off()
    nav.trackNav(LEAVE, Date.UTC(2026, 10, 18, 1))
    expect(heard).toEqual([OPEN, OPEN])
    expect(nav.readNavCounts()).toEqual({ '2026-11-17': { [navKey(OPEN)]: 2 }, '2026-11-18': { [navKey(LEAVE)]: 1 } })
    expect(nav.recentNav().map((r) => r.event)).toEqual([OPEN, OPEN, LEAVE])
    expect(JSON.parse(storage.getItem(NAV_STORAGE_KEY) ?? '{}')).toEqual(nav.readNavCounts())
  })

  it('drops what it would refuse, and never throws: a full storage, a bad row, a listener that fails', async () => {
    const nav = await import('../src/renderer/src/nav-events')
    nav.trackNav({ ...OPEN, from: 'Velvet' } as unknown as NavEvent)
    expect(nav.recentNav()).toEqual([])
    storage.setItem(NAV_STORAGE_KEY, '{"2026-11-17":{"x":"many"},"nope":{}}')
    expect(nav.readNavCounts()).toEqual({})
    storage.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    nav.subscribeNav(() => {
      throw new Error('reader broke')
    })
    expect(() => nav.trackNav(BACK)).not.toThrow()
    expect(nav.recentNav().map((r) => r.event)).toEqual([BACK])
  })
})
