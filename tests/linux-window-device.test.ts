// ONE X11 WINDOW AS A CARD (main/linux-window-device.ts) and the picker's
// window rows (linux-screen.ts · linuxSources): bound by X id, pictured by
// cropping the screen where the window is, driven at ratios of that picture laid
// on wherever the window is now, never outside it; gone and hidden said like a Mac.
import { describe, expect, it, vi } from 'vitest'
import { LinuxWindowDevice, type LinuxWindowDeps } from '../src/main/linux-window-device'
import { linuxSources, type LinuxSourceDeps } from '../src/main/linux-screen'
import type { XdoCall } from '../src/main/linux-input'
import type { X11Deps } from '../src/main/linux-windows'
import { DeviceGoneError, PixelInstance, type RemoteGate } from '../src/main/pixel-instance'
import type { RemoteState } from '../src/shared/remote-access'
import { parseUseUrl } from '../src/shared/use-url'

const term = { id: 4194316, title: 'term one', x: 50, y: 60, width: 400, height: 200, pid: 4680, cls: 'XTerm' }

function fakeX(windows: Array<typeof term & { hidden?: boolean }>): X11Deps {
  return {
    async xdotool(argv) {
      if (argv[0] === 'search') {
        const shown = windows.filter((w) => !w.hidden)
        if (shown.length === 0) throw Object.assign(new Error('exit 1'), { code: 1, stderr: '' })
        return shown.map((w) => `${w.id}\n`).join('')
      }
      const w = windows.find((candidate) => candidate.id === Number(argv[1]))
      if (!w) throw new Error('X Error of failed request:  BadWindow (invalid Window parameter)')
      if (argv[0] === 'getwindowname') return `${w.title}\nWINDOW=${w.id}\nX=${w.x}\nY=${w.y}\nWIDTH=${w.width}\nHEIGHT=${w.height}\nSCREEN=0\n`
      if (argv[0] === 'getwindowpid') return `${w.pid}\n`
      throw new Error(argv.join(' '))
    },
    xprop: async (argv) => `WM_CLASS(STRING) = "x", "${windows.find((w) => w.id === Number(argv[1]))?.cls ?? ''}"`,
    comm: () => null,
    selfPid: 1
  }
}

const gate = (over: Partial<RemoteGate> = {}): RemoteGate => ({
  blocked: async () => null,
  inputRefusal: () => null,
  agentRefusal: () => null,
  mayDrive: () => true,
  cardControl: () => ({ switchOn: true, until: null, heldBy: null, awake: false, machine: 'linux' }),
  admit: () => null,
  enter: () => () => undefined,
  ...over
})

function rig(windows: Array<typeof term & { hidden?: boolean }>, over: Partial<LinuxWindowDeps> = {}, url = `window://XTerm?id=${term.id}`) {
  const state = { windows }
  const send = vi.fn(async (_calls: readonly XdoCall[], _stopped?: () => string | null) => undefined)
  // The crop is half the window's size, as a fitted picture would be.
  const crop = vi.fn(async (rect: { x: number; y: number; width: number; height: number }) => ({ jpeg: Buffer.from('win'), width: rect.width / 2, height: rect.height / 2, rect }))
  const deps: LinuxWindowDeps = { remote: gate(), hand: { refusal: () => null, send }, x11: () => fakeX(state.windows), crop, now: () => 0, ...over }
  return { device: new LinuxWindowDevice(parseUseUrl(url)!, deps), send, crop, state }
}

const argvs = (send: ReturnType<typeof vi.fn>, n = 0): string[][] => (send.mock.calls[n][0] as XdoCall[]).map((call) => [...call.argv])

describe('LinuxWindowDevice', () => {
  it('pictures the window by cropping the screen where it is, sized as the crop came back', async () => {
    const { device, crop } = rig([term])
    const frame = await device.capture()
    expect(crop).toHaveBeenCalledWith({ x: 50, y: 60, width: 400, height: 200 })
    expect(frame).toMatchObject({ points: { width: 200, height: 100 }, subject: term.id })
    expect(device.title()).toBe('XTerm — term one')
  })

  it('a tap is a ratio of the picture laid on the window where it is NOW, after it comes to the front', async () => {
    const { device, send, state } = rig([term])
    await device.capture()
    state.windows = [{ ...term, x: 500, y: 300 }]
    await device.perform({ method: 'input.tap', params: { x: 100, y: 50 } })
    const calls = argvs(send)
    expect(calls[0]).toEqual(['windowactivate', String(term.id)])
    expect(calls[1]).toEqual(['windowraise', String(term.id), 'windowfocus', String(term.id), 'sleep', '0.05'])
    expect(calls[2]).toEqual(['mousemove', String(500 + 200), String(300 + 100), 'click', '1'])
    expect((send.mock.calls[0][0] as XdoCall[])[0].optional).toBe(true)
  })

  it('input never lands outside the window: a point off the picture stops at its edge', async () => {
    const { device, send } = rig([term])
    await device.capture()
    await device.perform({ method: 'input.tap', params: { x: 9999, y: -10 } })
    expect(argvs(send)[2].slice(0, 3)).toEqual(['mousemove', String(50 + 399), '60'])
  })

  it('a window partly off the screen is driven over the part that was pictured, at the same offset as it moves', async () => {
    const partial = { ...term, x: -100 }
    const crop = vi.fn(async () => ({ jpeg: Buffer.from('w'), width: 300, height: 200, rect: { x: 0, y: 60, width: 300, height: 200 } }))
    const { device, send, state } = rig([partial], { crop })
    await device.capture()
    state.windows = [{ ...partial, x: 0 }]
    await device.perform({ method: 'input.tap', params: { x: 0, y: 0 } })
    expect(argvs(send)[2].slice(0, 3)).toEqual(['mousemove', '100', '60'])
  })

  it('keys go to the window: focused first, then the key', async () => {
    const { device, send } = rig([term])
    await device.capture()
    await device.perform({ method: 'input.key', params: { name: 'return' } })
    expect(argvs(send).map((argv) => argv[0])).toEqual(['windowactivate', 'windowraise', 'key'])
  })

  it('the desk gates it like a screen: switch off, nothing sent', async () => {
    const off = 'Remote control of this machine is off.'
    const { device, send } = rig([term], { remote: gate({ inputRefusal: () => off }) })
    await expect(device.perform({ method: 'input.tap', params: { x: 1, y: 1 } })).rejects.toThrow(off)
    expect(send).not.toHaveBeenCalled()
  })

  it('Stop reaches into a gesture already running, as on a screen card', async () => {
    let refusal: string | null = null
    const { device, send } = rig([term], { remote: gate({ inputRefusal: () => refusal, agentRefusal: () => refusal }) })
    await device.capture()
    await device.perform({ method: 'input.type', params: { text: 'hi' } })
    const stopped = send.mock.calls[0][1] as () => string | null
    refusal = 'Stopped at the machine'
    expect(stopped()).toBe('Stopped at the machine')
  })

  it('a closed window is gone, the same way as a Mac window: the card offers the screen or another window', async () => {
    let clock = 0
    const { device, state } = rig([term], { now: () => (clock += 2000) })
    await device.capture()
    state.windows = []
    const error = await device.capture().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(DeviceGoneError)
    expect((error as DeviceGoneError).gone).toBe('window')
    expect((error as Error).message).toContain("The 'XTerm' window this card showed has closed")
  })

  it('alive but not shown is an ordinary offline that recovers by itself', async () => {
    const { device } = rig([{ ...term, hidden: true }])
    await expect(device.capture()).rejects.toThrow(/minimised or hidden/)
  })

  it('a window by name, with no id: the first shown window of that app whose title fits', async () => {
    const { device, crop } = rig([term], {}, 'window://xterm/one')
    await device.capture()
    expect(crop).toHaveBeenCalledWith(expect.objectContaining({ x: 50, y: 60 }))
  })

  it('no xdotool: one sentence naming the fix, not a crash', async () => {
    const { device } = rig([term], { x11: () => null })
    await expect(device.capture()).rejects.toThrow(/sudo apt install -y xdotool/)
  })

  it('a region of a window is still refused in words', async () => {
    const { device } = rig([term], {}, `window://XTerm?id=${term.id}&roi=0,0,100,100`)
    await expect(device.capture()).rejects.toThrow(/region/)
  })

  it('a blocked screen gives no picture and takes no input', async () => {
    const locked = { id: 'locked', platform: 'linux' } as RemoteState
    const { device, send } = rig([term], { remote: gate({ blocked: async () => locked }) })
    await expect(device.capture()).rejects.toThrow()
    await expect(device.perform({ method: 'input.tap', params: { x: 1, y: 1 } })).rejects.toThrow()
    expect(send).not.toHaveBeenCalled()
  })

  it('works as a PixelInstance: live, input allowed, a tap reaches the hand', async () => {
    const { device, send } = rig([term])
    const instance = new PixelInstance({ url: `window://XTerm?id=${term.id}`, device, schedule: () => () => undefined })
    instance.frameListeners.add(() => undefined)
    await instance.start()
    expect(instance.status).toMatchObject({ state: 'live', input: true, use: 'computer' })
    // An agent looks before its hand moves (pixel-instance.ts · look-first).
    await instance.look()
    await instance.act([{ method: 'input.tap', params: { x: 10, y: 10 } } as never])
    expect(send).toHaveBeenCalled()
    await instance.stop()
  })
})

describe('linuxSources: the Windows tab on X11', () => {
  const deps = (over: Partial<LinuxSourceDeps> = {}): LinuxSourceDeps => ({
    blocked: async () => null,
    grab: async () => [{ id: 'screen:0:0', name: 'Screen 1', displayId: '1', thumb: 'data:image/jpeg;base64,S', icon: null }],
    primaryDisplayId: () => '1',
    x11: () => fakeX([term, { ...term, id: 77, title: 'xeyes', cls: 'XEyes', x: 700, y: 100, width: 200, height: 150 }]),
    cropThumbs: async (rects) => rects.map((r) => `data:image/jpeg;base64,${r.x}`),
    ...over
  })

  it('lists the windows with app, title, a picture and a bound address, and the screens as before', async () => {
    const list = await linuxSources(deps()).list()
    expect(list.windowsNote).toBeNull()
    expect(list.windows).toEqual([
      expect.objectContaining({ id: `window:${term.id}`, kind: 'window', app: 'XTerm', title: 'term one', address: `window://XTerm?id=${term.id}`, thumb: 'data:image/jpeg;base64,50' }),
      expect.objectContaining({ id: 'window:77', app: 'XEyes', title: 'xeyes', thumb: 'data:image/jpeg;base64,700' })
    ])
    expect(list.screens.map((s) => s.id)).toEqual(['screen:main'])
  })

  it('pictures that fail leave the rows standing', async () => {
    const list = await linuxSources(deps({ cropThumbs: async () => Promise.reject(new Error('capturer')) })).list()
    expect(list.windows.map((w) => w.thumb)).toEqual([null, null])
  })

  it('no xdotool: the Windows tab says the one line that fixes it, and no "macOS only"', async () => {
    const list = await linuxSources(deps({ x11: () => null })).list()
    expect(list.windows).toEqual([])
    expect(list.windowsNote).toContain('sudo apt install -y xdotool')
    expect(list.windowsNote).not.toMatch(/macOS/)
  })

  it('nothing but Cookrew on the screen: an empty Windows tab that says why', async () => {
    const list = await linuxSources(deps({ x11: () => fakeX([]) })).list()
    expect(list.windows).toEqual([])
    expect(list.windowsNote).toMatch(/No other app has a window open/)
  })

  it('a list that fails says why on the Windows tab and keeps the screens', async () => {
    const broken: X11Deps = { ...fakeX([term]), xdotool: async () => Promise.reject(new Error("xdotool: Can't open display")) }
    const list = await linuxSources(deps({ x11: () => broken })).list()
    expect(list.state).toBe('ready')
    expect(list.windowsNote).toMatch(/open display/)
    expect(list.screens).toHaveLength(1)
  })
})
