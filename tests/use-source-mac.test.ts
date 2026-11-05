// THE MAC'S WINDOWS AND DISPLAYS, FOR THE PICKER (main/use-source-mac.ts),
// against a fake source: rows come from the list the card binds to, pictures
// are joined on by id, and a missing grant names itself instead of listing.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MacScreens } from '../src/main/mac-bridge'
import { SCREEN_RECORDING_OFF } from '../src/main/screen-device'
import { GRAB_DEADLINE_MS, MAX_WINDOWS, macSources, type GrabbedSource, type MacSourceDeps } from '../src/main/use-source-mac'
import { parseUseUrl } from '../src/shared/use-url'

const SELF = 900
const WECHAT = '\u5fae\u4fe1'
const screens: MacScreens = {
  displays: [
    { index: 1, id: 11, x: 0, y: 0, width: 1728, height: 1117 },
    { index: 2, id: 22, x: 1728, y: 0, width: 1920, height: 1080 }
  ],
  windows: [
    { id: 41, pid: 1, app: 'Safari', title: 'Docs', x: 0, y: 0, width: 1200, height: 900 },
    { id: 42, pid: SELF, app: 'Electron', title: 'Cookrew', x: 0, y: 0, width: 1600, height: 1000 },
    { id: 43, pid: 2, app: WECHAT, title: '', x: 0, y: 0, width: 800, height: 600 }
  ]
}
const grabbed: GrabbedSource[] = [
  { id: 'window:41:0', name: 'Docs', displayId: '', thumb: 'data:image/jpeg;base64,T41', icon: 'data:image/png;base64,I41' },
  { id: 'screen:22:0', name: 'Screen 2', displayId: '22', thumb: 'data:image/jpeg;base64,S22', icon: null },
  { id: 'screen:11:0', name: 'Screen 1', displayId: '11', thumb: 'data:image/jpeg;base64,S11', icon: null }
]

const bed = (over: Partial<MacSourceDeps> = {}) => {
  const deps: MacSourceDeps = {
    access: () => 'granted',
    screens: vi.fn(async () => screens),
    grab: vi.fn(async () => grabbed),
    selfPid: SELF,
    openSettings: vi.fn(async () => undefined),
    ...over
  }
  return { deps, sources: macSources(deps) }
}

afterEach(() => void vi.useRealTimers())

describe('macSources · list', () => {
  it('lists windows front to back with their pictures, and writes an address bound to the id', async () => {
    const list = await bed().sources.list()
    expect(list.state).toBe('ready')
    expect(list.windows[0]).toMatchObject({
      id: 'window:41',
      kind: 'window',
      title: 'Docs',
      app: 'Safari',
      address: 'window://Safari?id=41',
      thumb: 'data:image/jpeg;base64,T41',
      icon: 'data:image/png;base64,I41',
      width: 1200,
      height: 900
    })
  })

  it('never offers Cookrew itself: a card of its own window is a hall of mirrors', async () => {
    const list = await bed().sources.list()
    expect(list.windows.map((w) => w.id)).toEqual(['window:41', 'window:43'])
  })

  it('a window with no title goes by its app, and any app name still makes an address that parses', async () => {
    const list = await bed().sources.list()
    const wechat = list.windows[1]
    expect(wechat.title).toBe(WECHAT)
    expect(parseUseUrl(wechat.address)).toMatchObject({ kind: 'window', name: WECHAT, windowId: 43 })
  })

  it('lists displays, main first, each with the address the card already speaks', async () => {
    const list = await bed().sources.list()
    expect(list.screens.map((s) => [s.id, s.address, s.thumb])).toEqual([
      ['screen:main', 'screen://main', 'data:image/jpeg;base64,S11'],
      ['screen:2', 'screen://2', 'data:image/jpeg;base64,S22']
    ])
    expect(list.screens[0].title).toBe('Main display')
    expect(list.screens[1].title).toBe('Display 2')
  })

  it('a row keeps its place when its picture is missing, and when the pictures fail altogether', async () => {
    const none = await bed({ grab: async () => [] }).sources.list()
    expect(none.windows[0]).toMatchObject({ id: 'window:41', thumb: null, icon: null })
    const broken = await bed({ grab: async () => Promise.reject(new Error('capturer died')) }).sources.list()
    expect(broken.state).toBe('ready')
    expect(broken.windows).toHaveLength(2)
  })

  it('a capturer that never answers costs the pictures, not the list', async () => {
    vi.useFakeTimers()
    const pending = bed({ grab: () => new Promise(() => undefined) }).sources.list()
    await vi.advanceTimersByTimeAsync(GRAB_DEADLINE_MS + 1)
    const list = await pending
    expect(list.state).toBe('ready')
    expect(list.windows[0]).toMatchObject({ id: 'window:41', thumb: null })
  })

  it('caps the list, so a Mac with a hundred windows is not a megabyte to a phone', async () => {
    const many: MacScreens = {
      displays: screens.displays,
      windows: Array.from({ length: MAX_WINDOWS + 10 }, (_, i) => ({ id: i + 1, pid: 1, app: 'A', title: `w${i}`, x: 0, y: 0, width: 100, height: 100 }))
    }
    const list = await bed({ screens: async () => many }).sources.list()
    expect(list.windows).toHaveLength(MAX_WINDOWS)
  })

  it('a list that cannot be read says so instead of showing nothing', async () => {
    const list = await bed({ screens: async () => Promise.reject(new Error("could not list this Mac's windows")) }).sources.list()
    expect(list.state).toBe('unavailable')
    expect(list.message).toMatch(/could not list/)
  })
})

describe('macSources · Screen Recording', () => {
  it.each(['denied', 'not-determined', 'restricted', 'unknown'])('%s: names the permission, and neither lists nor captures', async (access) => {
    const { deps, sources } = bed({ access: () => access })
    const list = await sources.list()
    expect(list).toMatchObject({ state: 'needs-permission', permission: 'Screen Recording', message: SCREEN_RECORDING_OFF, windows: [], screens: [] })
    expect(deps.screens).not.toHaveBeenCalled()
    expect(deps.grab).not.toHaveBeenCalled()
  })

  it('opens the settings page on demand', async () => {
    const { deps, sources } = bed({ access: () => 'denied' })
    await sources.openSettings()
    expect(deps.openSettings).toHaveBeenCalledOnce()
  })
})
