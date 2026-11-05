// WHICH SCREEN SOURCE A MACHINE GETS (main/use-instances.ts), with Electron
// faked: the Linux branch is the desktopCapturer one, with no way to act on
// the screen, and the Mac branch keeps its id lookup wired.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const image = (empty = false) => ({
  isEmpty: () => empty,
  getSize: () => ({ width: 1920, height: 1080 }),
  resize: () => image(empty),
  toJPEG: () => Buffer.from('jpeg'),
  toPNG: () => Buffer.from('png')
})

const electron = vi.hoisted(() => ({
  getSources: vi.fn(),
  access: vi.fn(() => 'granted'),
  openExternal: vi.fn(async () => undefined),
  trusted: vi.fn(() => false)
}))

vi.mock('electron', () => ({
  BrowserWindow: class {},
  session: {},
  nativeImage: {},
  desktopCapturer: { getSources: electron.getSources },
  screen: { getPrimaryDisplay: () => ({ id: 7 }) },
  shell: { openExternal: electron.openExternal },
  clipboard: { readText: () => '' },
  systemPreferences: { getMediaAccessStatus: electron.access, isTrustedAccessibilityClient: electron.trusted }
}))

const { createUseInstances } = await import('../src/main/use-instances')
const { parseUseUrl } = await import('../src/shared/use-url')
const { LINUX_WAYLAND } = await import('../src/main/linux-screen')
const { ASK_DEADLINE_MS } = await import('../src/main/use-source-electron')

const make = (platform: NodeJS.Platform, env: Record<string, string> = { DISPLAY: ':99', XDG_SESSION_TYPE: 'x11' }) =>
  createUseInstances({
    captureDir: path.join(mkdtempSync(path.join(tmpdir(), 'use-inst-')), 'c'),
    remote: () => ({ blocked: async () => null, inputRefusal: () => null, mayDrive: () => false, cardControl: () => ({ switchOn: false, until: null, heldBy: null, awake: false, machine: 'darwin' }), admit: () => null, enter: () => () => undefined }),
    blocked: async () => (env.XDG_SESSION_TYPE === 'wayland' ? ({ id: 'unsupported', platform: 'linux', detail: LINUX_WAYLAND, then: null, lastSeenAt: null, until: null, waiting: false, build: { settingsName: 'Cookrew', sourceBuild: false, restart: 'self', agents: 'keep' } } as const) : null),
    platform
  })

beforeEach(() => {
  electron.getSources.mockReset()
  electron.getSources.mockResolvedValue([{ id: 'screen:0:0', name: 'Screen 1', display_id: '7', thumbnail: image(), appIcon: null }])
  electron.openExternal.mockClear()
})

describe('on Linux', () => {
  it('screen://main is a live card from desktopCapturer, view only even with computer input on', async () => {
    const instance = make('linux').makeInstance(parseUseUrl('screen://main')!, { id: 'n' }) as unknown as {
      start(): Promise<void>
      stop(): Promise<unknown>
      status: { state: string; input: boolean }
    }
    await instance.start()
    expect(instance.status).toMatchObject({ state: 'live', input: false })
    expect(electron.getSources).toHaveBeenCalled()
    await instance.stop()
  })

  it('lists its displays, and on Wayland answers a sentence without capturing', async () => {
    const list = await make('linux').sources()?.list()
    expect(list?.screens[0]).toMatchObject({ id: 'screen:main', address: 'screen://main' })
    electron.getSources.mockClear()
    const wayland = await make('linux', { XDG_SESSION_TYPE: 'wayland' }).sources()?.list()
    expect(wayland).toMatchObject({ state: 'unavailable', message: LINUX_WAYLAND })
    expect(electron.getSources).not.toHaveBeenCalled()
  })
})

describe('on a Mac', () => {
  it('the settings button goes to Screen Recording itself, and a Mac that was never asked gets asked first', async () => {
    electron.access.mockReturnValue('not-determined')
    await make('darwin').sources()?.openSettings('screen')
    expect(electron.getSources).toHaveBeenCalledOnce()
    expect(electron.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    electron.getSources.mockClear()
    electron.access.mockReturnValue('denied')
    await make('darwin').sources()?.openSettings('screen')
    expect(electron.getSources).not.toHaveBeenCalled()
  })
})

describe('the Accessibility jump', () => {
  it('asks once, so a row exists to switch on, and lands on that page', async () => {
    electron.trusted.mockClear()
    await make('darwin').sources()?.openSettings('accessibility')
    expect(electron.trusted).toHaveBeenCalledWith(true)
    expect(electron.openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility')
  })
})

describe('the settings button on a Mac that was never asked', () => {
  it('still opens the page when the system question never comes back', async () => {
    vi.useFakeTimers()
    electron.access.mockReturnValue('not-determined')
    electron.getSources.mockReturnValue(new Promise(() => undefined))
    const opening = make('darwin').sources()?.openSettings('screen')
    await vi.advanceTimersByTimeAsync(ASK_DEADLINE_MS + 1)
    await opening
    vi.useRealTimers()
    expect(electron.openExternal).toHaveBeenCalledOnce()
  })
})

describe('anywhere else', () => {
  it('has no source and no screen card', () => {
    const uses = make('win32')
    expect(uses.sources()).toBeNull()
    expect(uses.makeInstance(parseUseUrl('screen://main')!, { id: 'n' })).toBeNull()
  })
})
