// THE WHOLE SCREEN ON LINUX (main/linux-screen.ts), against a fake capturer:
// X11 works through desktopCapturer, Wayland and a missing display are said
// in words, and input goes through the desk's gates to xdotool.
import { describe, expect, it, vi } from 'vitest'
import { LINUX_NO_DISPLAY, LINUX_NO_REGION, LINUX_NO_WINDOW, LINUX_WAYLAND, LinuxScreenDevice, linuxScreenRefusal, linuxSources, type LinuxFrame, type LinuxScreenDeps } from '../src/main/linux-screen'
import { PixelInstance } from '../src/main/pixel-instance'
import type { RemoteGate } from '../src/main/pixel-instance'
import type { RemoteState, RemoteStateId } from '../src/shared/remote-access'
import { parseUseUrl } from '../src/shared/use-url'
import type { XdoCall } from '../src/main/linux-input'

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
  agentRefusal: () => null,
  mayDrive: () => false,
  cardControl: () => ({ switchOn: false, until: null, heldBy: null, awake: false, machine: 'darwin' }),
  admit: () => null,
  enter: () => () => undefined
})
const fakeHand = (refusal: string | null = null) => ({ refusal: () => refusal, send: vi.fn(async (_calls: readonly XdoCall[]) => undefined) })
const deps = (over: Partial<LinuxScreenDeps> = {}): LinuxScreenDeps => ({
  remote: gate(),
  frames: vi.fn(async () => frames),
  primaryDisplayId: () => '1',
  area: () => ({ x: 0, y: 0, width: 3840, height: 2160 }),
  hand: fakeHand(),
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

  it('input waits on the desk: with the switch off nothing is sent, and an agent is told why', async () => {
    const hand = fakeHand()
    const off = 'Remote control of this machine is off.'
    const screen = device('screen://main', { hand, remote: { ...gate(), inputRefusal: () => off, agentRefusal: () => off } })
    expect(screen.inputRefusal()).toBe(off)
    const instance = new PixelInstance({ url: 'screen://main', device: screen, schedule: () => () => undefined })
    instance.frameListeners.add(() => undefined)
    await instance.start()
    expect(instance.status).toMatchObject({ state: 'live', input: false, use: 'computer' })
    await expect(instance.act([{ method: 'input.tap', params: { x: 1, y: 1 } } as never])).rejects.toThrow(off)
    await expect(screen.perform({ method: 'input.tap', params: { x: 1, y: 1 } })).rejects.toThrow(off)
    expect(hand.send).not.toHaveBeenCalled()
    await instance.stop()
  })

  it('with the desk open and no xdotool, the hand says what to install', async () => {
    const hand = fakeHand('install xdotool')
    const screen = device('screen://main', { hand })
    expect(screen.inputRefusal()).toBe('install xdotool')
    await expect(screen.perform({ method: 'input.tap', params: { x: 1, y: 1 } })).rejects.toThrow('install xdotool')
    expect(hand.send).not.toHaveBeenCalled()
  })

  it('a tap on the frame lands at the same ratio of the display it shows', async () => {
    const hand = fakeHand()
    const area = vi.fn(() => ({ x: 1920, y: 0, width: 3840, height: 2160 }))
    const screen = device('screen://main', { hand, area })
    await screen.capture()
    await screen.perform({ method: 'input.tap', params: { x: 960, y: 540 } })
    expect(area).toHaveBeenCalledWith(expect.objectContaining({ displayId: '1', index: 1 }))
    expect(hand.send.mock.calls[0][0]).toEqual([{ argv: ['mousemove', String(1920 + 1920), '1080', 'click', '1'], timeoutMs: expect.any(Number) }])
  })

  it('a gesture before any frame takes one first, so the ratio is of a real picture', async () => {
    const hand = fakeHand()
    const frames = vi.fn(async () => [{ displayId: '1', jpeg: Buffer.from('x'), width: 100, height: 50 }])
    const screen = device('screen://main', { hand, frames })
    await screen.perform({ method: 'input.tap', params: { x: 50, y: 25 } })
    expect(frames).toHaveBeenCalledTimes(1)
    expect(hand.send.mock.calls[0][0][0].argv.slice(0, 3)).toEqual(['mousemove', '1920', '1080'])
  })

  it('a blocked screen takes no input, whatever the switch says', async () => {
    const hand = fakeHand()
    const screen = device('screen://main', { hand, remote: gate(stateOf('locked')) })
    await expect(screen.perform({ method: 'input.tap', params: { x: 1, y: 1 } })).rejects.toThrow(/locked/)
    expect(hand.send).not.toHaveBeenCalled()
  })

  it('a display that went away is said, not guessed', async () => {
    const screen = device('screen://main', { area: () => null })
    await screen.capture()
    await expect(screen.perform({ method: 'input.tap', params: { x: 1, y: 1 } })).rejects.toThrow(/Display main is not connected/)
  })

  it('a shortcut reads the clipboard back for the viewer, like a Mac', async () => {
    const screen = device('screen://main', { readClipboard: () => 'copied' })
    expect(screen.readClipboard?.()).toBe('copied')
  })

  it('a session that rests forgets the frame it measured from', async () => {
    const frames = vi.fn(async () => [{ displayId: '1', jpeg: Buffer.from('x'), width: 100, height: 50 }])
    const screen = device('screen://main', { frames })
    await screen.capture()
    screen.rest()
    await screen.perform({ method: 'input.tap', params: { x: 1, y: 1 } })
    expect(frames).toHaveBeenCalledTimes(2)
  })
})

describe('the same states as a Mac', () => {
  it('a locked or sleeping machine gives no frame, and says so on the card', async () => {
    const frames2 = vi.fn(async () => frames)
    const instance = new PixelInstance({ url: 'screen://main', device: device('screen://main', { remote: gate(stateOf('locked')), frames: frames2 }), schedule: () => () => undefined })
    instance.frameListeners.add(() => undefined)
    await instance.start()
    expect(instance.status).toMatchObject({ state: 'offline', remote: { id: 'locked', platform: 'linux' } })
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
