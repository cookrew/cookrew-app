// THE WHOLE SCREEN ON LINUX (main/linux-screen.ts), against a fake capturer:
// X11 works through desktopCapturer, Wayland and a missing display are said
// in words, and there is no input of any kind.
import { describe, expect, it, vi } from 'vitest'
import { LINUX_INPUT_OFF, LINUX_NO_DISPLAY, LINUX_NO_REGION, LINUX_NO_WINDOW, LINUX_WAYLAND, LinuxScreenDevice, linuxScreenRefusal, linuxSources, type LinuxFrame, type LinuxScreenDeps } from '../src/main/linux-screen'
import { PixelInstance } from '../src/main/pixel-instance'
import type { RemoteGate } from '../src/main/pixel-instance'
import type { RemoteState, RemoteStateId } from '../src/shared/remote-access'
import { parseUseUrl } from '../src/shared/use-url'

const X11 = { DISPLAY: ':99', XDG_SESSION_TYPE: 'x11' }
const frames: LinuxFrame[] = [
  { displayId: '2', jpeg: Buffer.from('second'), width: 1024, height: 768 },
  { displayId: '1', jpeg: Buffer.from('primary'), width: 1920, height: 1080 }
]
const stateOf = (id: RemoteStateId, detail: string | null = null): RemoteState => ({
  id, platform: 'linux', then: null, detail, lastSeenAt: null, until: null, waiting: false,
  build: { settingsName: 'Cookrew', sourceBuild: false, restart: 'self', agents: 'keep' }
})
const gate = (blocked: RemoteState | null = null): RemoteGate => ({
  blocked: async () => blocked,
  inputRefusal: () => null,
  mayDrive: () => false,
  cardControl: () => ({ switchOn: false, until: null, heldBy: null, awake: false, machine: 'darwin' }),
  admit: () => null,
  enter: () => () => undefined
})
const deps = (over: Partial<LinuxScreenDeps> = {}): LinuxScreenDeps => ({
  remote: gate(),
  frames: vi.fn(async () => frames),
  primaryDisplayId: () => '1',
  ...over
})
const device = (url: string, over: Partial<LinuxScreenDeps> = {}) => new LinuxScreenDevice(parseUseUrl(url)!, deps(over))

describe('linuxScreenRefusal', () => {
  it('is nothing on X11', () => {
    expect(linuxScreenRefusal(X11)).toBeNull()
    expect(linuxScreenRefusal({ DISPLAY: ':0' })).toBeNull()
  })
  it('names Wayland, including under XWayland where DISPLAY is set and the capture is black', () => {
    expect(linuxScreenRefusal({ XDG_SESSION_TYPE: 'wayland' })).toBe(LINUX_WAYLAND)
    expect(linuxScreenRefusal({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe(LINUX_WAYLAND)
  })
  it('says when there is no display at all', () => {
    expect(linuxScreenRefusal({})).toBe(LINUX_NO_DISPLAY)
  })
})

describe('LinuxScreenDevice', () => {
  it('screen://main is the primary display, by id, wherever it sits in the list', async () => {
    const screen = device('screen://main')
    expect(await screen.open()).toEqual({ width: 1920, height: 1080 })
    const frame = await screen.capture()
    expect(Buffer.from(frame.jpeg, 'base64').toString()).toBe('primary')
    expect(frame.points).toEqual({ width: 1920, height: 1080 })
  })

  it('screen://main falls back to the first display when ids do not match (Xvfb gives none)', async () => {
    const screen = device('screen://main', { primaryDisplayId: () => 'nope' })
    expect(Buffer.from((await screen.capture()).jpeg, 'base64').toString()).toBe('second')
  })

  it('a numbered display is its place in the list; a missing one says how many there are', async () => {
    expect(Buffer.from((await device('screen://2').capture()).jpeg, 'base64').toString()).toBe('primary')
    await expect(device('screen://3').open()).rejects.toThrow(/Display 3 is not connected \(this machine has 2\)/)
  })

  it('a display with no picture keeps its number: screen://2 never shows another one', async () => {
    const blank: LinuxFrame[] = [{ displayId: '2', jpeg: null, width: 0, height: 0 }, frames[1]]
    expect(Buffer.from((await device('screen://2', { frames: async () => blank }).capture()).jpeg, 'base64').toString()).toBe('primary')
    await expect(device('screen://1', { frames: async () => blank }).open()).rejects.toThrow(/gave no picture of display 1/)
  })

  it('every picture empty is a failed capture, not a machine with no displays', async () => {
    await expect(device('screen://main', { frames: async () => [{ displayId: '1', jpeg: null, width: 0, height: 0 }] }).open()).rejects.toThrow(/gave no picture of display main/)
  })

  it('refuses in words what it cannot show: Wayland, a window, a region', async () => {
    await expect(device('screen://main', { remote: gate(stateOf('unsupported', LINUX_WAYLAND)) }).open()).rejects.toThrow(LINUX_WAYLAND)
    await expect(device('window://Firefox').open()).rejects.toThrow(LINUX_NO_WINDOW)
    await expect(device('screen://main?roi=0,0,100,100').open()).rejects.toThrow(LINUX_NO_REGION)
  })

  it('takes no input at all: no perform, and an agent is told why', async () => {
    const screen = device('screen://main')
    expect((screen as { perform?: unknown }).perform).toBeUndefined()
    expect(screen.inputRefusal()).toBe(LINUX_INPUT_OFF)
    const instance = new PixelInstance({ url: 'screen://main', device: screen, schedule: () => () => undefined })
    await instance.start()
    expect(instance.status).toMatchObject({ state: 'live', input: false, use: 'computer' })
    await expect(instance.act([{ method: 'input.tap', params: { x: 1, y: 1 } } as never])).rejects.toThrow(LINUX_INPUT_OFF)
    instance.dispatchInput('Input.dispatchMouseEvent' as never, { type: 'mousePressed', x: 1, y: 1 } as never)
    await instance.stop()
  })
})

describe('the same states as a Mac', () => {
  it('a locked or sleeping machine gives no frame, and says so on the card', async () => {
    const frames2 = vi.fn(async () => frames)
    const instance = new PixelInstance({ url: 'screen://main', device: device('screen://main', { remote: gate(stateOf('locked')), frames: frames2 }), schedule: () => () => undefined })
    await instance.start()
    expect(instance.status).toMatchObject({ state: 'offline', input: false, remote: { id: 'locked', platform: 'linux' } })
    expect(instance.status.message).not.toMatch(/System Settings|\bMac\b/)
    expect(frames2).not.toHaveBeenCalled()
    await instance.stop()
  })
})

describe('linuxSources', () => {
  const grab = async () => [
    { id: 'screen:0:0', name: 'Screen 1', displayId: '1', thumb: 'data:image/jpeg;base64,A', icon: null },
    { id: 'screen:1:0', name: 'Screen 2', displayId: '2', thumb: 'data:image/jpeg;base64,B', icon: null }
  ]
  const sourceDeps = { blocked: async () => null, grab, primaryDisplayId: () => '2' }

  it('lists the displays, primary first, and says windows are Mac only', async () => {
    const list = await linuxSources(sourceDeps).list()
    expect(list.state).toBe('ready')
    expect(list.windows).toEqual([])
    expect(list.windowsNote).toBe(LINUX_NO_WINDOW)
    expect(list.screens.map((s) => [s.id, s.address, s.thumb])).toEqual([
      ['screen:main', 'screen://main', 'data:image/jpeg;base64,B'],
      // Its place in the capturer's list: the address the device reads back.
      ['screen:1', 'screen://1', 'data:image/jpeg;base64,A']
    ])
  })

  it('on Wayland: a plain sentence and no capture', async () => {
    const spy = vi.fn(grab)
    const list = await linuxSources({ ...sourceDeps, blocked: async () => stateOf('unsupported', LINUX_WAYLAND), grab: spy }).list()
    expect(list).toMatchObject({ state: 'unavailable', message: LINUX_WAYLAND, remote: { id: 'unsupported' }, screens: [] })
    expect(spy).not.toHaveBeenCalled()
  })
})
