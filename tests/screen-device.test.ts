// A REGION OF THIS MAC'S SCREEN (main/screen-device.ts): which window an
// address names, what screencapture is asked for, how a roi is cut, how a
// gesture lands in global points and never outside the region, and the two
// grants that refuse in words.
import { describe, expect, it } from 'vitest'
import type { MacOp, MacScreens } from '../src/main/mac-bridge'
import { DeviceBlockedError, DeviceGoneError, type RemoteGate } from '../src/main/pixel-instance'
import { ScreenDevice, clipRoi, findWindow, type ScreenDeps } from '../src/main/screen-device'
import type { RemoteState, RemoteStateId } from '../src/shared/remote-access'
import { parseUseUrl } from '../src/shared/use-url'

const screens: MacScreens = {
  displays: [
    { index: 1, id: 1, x: 0, y: 0, width: 1728, height: 1117 },
    { index: 2, id: 7, x: 1728, y: 0, width: 1920, height: 1080 }
  ],
  windows: [
    { id: 41, app: 'Simulator', title: 'iPhone 17 Pro', x: 100, y: 50, width: 400, height: 860 },
    { id: 42, app: 'Safari', title: 'Docs', x: 300, y: 80, width: 1200, height: 900 },
    { id: 43, app: 'Simulator', title: 'iPad Air', x: 600, y: 60, width: 900, height: 700 }
  ]
}

const blockedBy = (id: RemoteStateId): RemoteState => ({
  id, platform: 'darwin', then: null, detail: null, lastSeenAt: null, until: null, waiting: false,
  build: { settingsName: 'Electron', sourceBuild: true, restart: 'by-hand', agents: 'keep' }
})

const INPUT_OFF = 'Remote control of this Mac is off.'

/** The desk, as a card sees it: nothing in the way, and input allowed, unless a test says otherwise. */
function gate(over: Partial<RemoteGate> = {}): RemoteGate {
  return {
    blocked: async () => null,
    inputRefusal: () => null,
    mayDrive: () => true,
    cardControl: () => ({ switchOn: true, until: null, heldBy: null, awake: false, machine: 'darwin' }),
    admit: () => null,
    enter: () => () => undefined,
    ...over
  }
}

function bed(url: string, over: Partial<ScreenDeps> = {}) {
  const captured: string[][] = []
  const ops: MacOp[] = []
  const crops: Array<unknown> = []
  let now = 0
  const deps: ScreenDeps = {
    list: async () => screens,
    windowAlive: async () => null,
    capture: async (args) => {
      captured.push([...args])
    },
    read: async () => Buffer.from('raw'),
    remove: async () => undefined,
    encode: (_jpeg, crop) => {
      crops.push(crop)
      return Buffer.from('jpeg')
    },
    remote: gate(),
    hand: () => ({ send: async (op: MacOp) => void ops.push(op) }) as never,
    now: () => now,
    tmp: '/tmp',
    ...over
  }
  const device = new ScreenDevice(parseUseUrl(url)!, deps)
  return { device, captured, ops, crops, tick: (ms: number) => (now += ms) }
}

describe('findWindow and clipRoi', () => {
  it('exact app first, title by fragment, front-most wins', () => {
    expect(findWindow(screens.windows, 'simulator', null)?.id).toBe(41)
    expect(findWindow(screens.windows, 'Simulator', 'ipad')?.id).toBe(43)
    expect(findWindow(screens.windows, 'Safar', null)?.id).toBe(42)
    expect(findWindow(screens.windows, 'Xcode', null)).toBeNull()
  })
  it('a roi is clipped to its area; one wholly outside is nothing', () => {
    expect(clipRoi({ width: 400, height: 860 }, null)).toEqual({ x: 0, y: 0, width: 400, height: 860 })
    expect(clipRoi({ width: 400, height: 860 }, { x: 300, y: 800, width: 500, height: 500 })).toEqual({ x: 300, y: 800, width: 100, height: 60 })
    expect(clipRoi({ width: 400, height: 860 }, { x: 395, y: 0, width: 100, height: 100 })).toBeNull()
  })
})

describe('ScreenDevice', () => {
  it('a window is captured by id; its roi is cut as a fraction of the window', async () => {
    const { device, captured, crops } = bed('window://Simulator/iPhone?roi=0,100,400,400')
    expect(await device.open()).toEqual({ width: 400, height: 400 })
    const frame = await device.capture()
    expect(captured[0].slice(0, 5)).toEqual(['-x', '-o', '-t', 'jpg', '-l41'])
    expect(crops[0]).toEqual({ x: 0, y: 100 / 860, width: 1, height: 400 / 860 })
    expect(frame.points).toEqual({ width: 400, height: 400 })
  })

  it('a display region is captured by global rectangle', async () => {
    const { device, captured, crops } = bed('screen://2?roi=10,20,800,600')
    await device.open()
    await device.capture()
    expect(captured[0].slice(0, 4)).toEqual(['-x', '-t', 'jpg', '-R1738,20,800,600'])
    expect(crops[0]).toBeNull()
  })

  it('a tap lands in global points; a drag that wanders off stops at the region edge', async () => {
    const { device, ops } = bed('window://Simulator/iPhone')
    await device.open()
    await device.perform({ method: 'input.tap', params: { x: 200, y: 430 } })
    await device.perform({ method: 'input.swipe', params: { x1: 10, y1: 10, x2: 5000, y2: -40, seconds: 0.3 } })
    await device.perform({ method: 'input.scroll', params: { x: 200, y: 200, dx: 0, dy: 120 } })
    await device.perform({ method: 'input.key', params: { name: 'return' } })
    await device.perform({ method: 'input.paste', params: { text: '你好' } })
    expect(ops).toEqual([
      { op: 'click', x: 300, y: 480 },
      { op: 'drag', x1: 110, y1: 60, x2: 499, y2: 50, ms: 300 },
      { op: 'scroll', x: 300, y: 250, dx: 0, dy: 120 },
      { op: 'key', code: 36 },
      { op: 'type', text: '你好' }
    ])
  })

  it('looks the window up again once its lookup is a second old, so a moved window is clicked where it is now', async () => {
    let x = 100
    const { device, ops, tick } = bed('window://Simulator/iPhone', {
      list: async () => ({ ...screens, windows: [{ ...screens.windows[0], x }] })
    })
    await device.open()
    x = 700
    tick(1200)
    await device.perform({ method: 'input.tap', params: { x: 0, y: 0 } })
    expect(ops[0]).toEqual({ op: 'click', x: 700, y: 50 })
  })

  it('says what is missing: the window, Screen Recording, the input switch, Accessibility', async () => {
    await expect(bed('window://Xcode').device.open()).rejects.toThrow(/No 'Xcode' window is on screen/)
    await expect(bed('screen://3').device.open()).rejects.toThrow(/Display 3 is not connected \(this Mac has 2\)/)
    await expect(bed('screen://main', { remote: gate({ blocked: async () => blockedBy('needs-screen-recording') }) }).device.open()).rejects.toBeInstanceOf(DeviceBlockedError)
    const off = bed('screen://main', { remote: gate({ inputRefusal: () => INPUT_OFF }) })
    expect(off.device.inputRefusal()).toBe(INPUT_OFF)
    await expect(off.device.perform({ method: 'input.tap', params: { x: 1, y: 1 } })).rejects.toThrow(INPUT_OFF)
    expect(off.ops).toEqual([])
  })

  it('a capture that fails is checked against the desk: a revoked grant says so, not the tool\u2019s own words', async () => {
    const asked: Array<boolean | undefined> = []
    let granted = true
    const { device } = bed('screen://main', {
      remote: gate({
        blocked: async (options) => {
          asked.push(options?.afterFailure)
          return granted ? null : blockedBy('needs-screen-recording')
        }
      }),
      capture: async () => {
        throw new Error('screencapture: could not create image from display')
      }
    })
    await device.open()
    await expect(device.capture()).rejects.toThrow('screencapture')
    expect(asked).toContain(true)
    granted = false
    await expect(device.capture()).rejects.toBeInstanceOf(DeviceBlockedError)
  })

  it('a locked Mac gives no frame and takes no capture at all', async () => {
    let locked = false
    const { device, captured } = bed('screen://main', { remote: gate({ blocked: async () => (locked ? blockedBy('locked') : null) }) })
    await device.open()
    await device.capture()
    const before = captured.length
    locked = true
    await expect(device.capture()).rejects.toBeInstanceOf(DeviceBlockedError)
    expect(captured).toHaveLength(before)
  })

  it('no gesture reaches the hand on a locked Mac, however it was allowed a moment ago', async () => {
    let locked = false
    const { device, ops } = bed('screen://main', { remote: gate({ blocked: async () => (locked ? blockedBy('locked') : null) }) })
    await device.open()
    locked = true
    await expect(device.perform({ method: 'input.type', params: { text: 'hunter2' } })).rejects.toBeInstanceOf(DeviceBlockedError)
    await expect(device.perform({ method: 'input.key', params: { name: 'return' } })).rejects.toBeInstanceOf(DeviceBlockedError)
    expect(ops).toEqual([])
  })

  it('a chord goes as a chord: Command held on the key', async () => {
    const { device, ops } = bed('screen://main')
    await device.open()
    await device.perform({ method: 'input.key', params: { name: 'c', mods: 'cmd' } })
    await device.perform({ method: 'input.key', params: { name: 'return' } })
    expect(ops).toEqual([{ op: 'key', code: 8, cmd: true }, { op: 'key', code: 36 }])
  })

  it('a window card refuses a click where another window covers it, and keys when it is not in front', async () => {
    // Safari (42) is listed in front of the iPad window (43): it covers part of it.
    const { device, ops } = bed('window://Simulator/iPad')
    await device.open()
    await expect(device.perform({ method: 'input.tap', params: { x: 100, y: 100 } })).rejects.toThrow(/covered there by 'Safari'/)
    await expect(device.perform({ method: 'input.type', params: { text: 'rm -rf' } })).rejects.toThrow(/not the front window, so keys would go to 'Simulator'/)
    // Its top strip (y 60–80) is above Safari's top edge: a click there goes through.
    await device.perform({ method: 'input.tap', params: { x: 850, y: 10 } })
    expect(ops).toEqual([{ op: 'click', x: 1450, y: 70 }])
  })

  it('the front window takes keys', async () => {
    const { device, ops } = bed('window://Simulator/iPhone')
    await device.open()
    await device.perform({ method: 'input.key', params: { name: 'return' } })
    expect(ops).toEqual([{ op: 'key', code: 36 }])
  })
})

describe('a card bound to one window', () => {
  const without = (id: number): MacScreens => ({ ...screens, windows: screens.windows.filter((w) => w.id !== id) })

  it('follows the id, whatever else carries the same name', async () => {
    const { device, captured } = bed('window://Simulator?id=43')
    expect(await device.open()).toEqual({ width: 900, height: 700 })
    await device.capture()
    expect(captured[0]).toContain('-l43')
  })

  it('a closed window is gone, and never falls back to another window of that app', async () => {
    const { device, captured } = bed('window://Simulator?id=43', { list: async () => without(43), windowAlive: async () => null })
    const failure = await device.open().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(DeviceGoneError)
    expect((failure as DeviceGoneError).gone).toBe('window')
    expect((failure as Error).message).toMatch(/closed/)
    expect(captured).toEqual([])
  })

  it('an id another app now holds is gone too: an old address never shows a stranger', async () => {
    const { device } = bed('window://Safari?id=43')
    await expect(device.open()).rejects.toBeInstanceOf(DeviceGoneError)
    const offscreen = bed('window://Safari?id=99', { windowAlive: async () => ({ app: 'Messages' }) })
    await expect(offscreen.device.open()).rejects.toBeInstanceOf(DeviceGoneError)
  })

  it('minimised or on another Space is not closed: it says so and stays a plain offline', async () => {
    const { device } = bed('window://Simulator?id=43', { list: async () => without(43), windowAlive: async () => ({ app: 'Simulator' }) })
    const failure = await device.open().catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(DeviceGoneError)
    expect((failure as Error).message).toMatch(/minimised or on another Space/)
  })

  it('a failed lookup is not proof the window closed', async () => {
    const { device } = bed('window://Simulator?id=43', {
      list: async () => without(43),
      windowAlive: async () => {
        throw new Error('osascript timed out')
      }
    })
    const failure = await device.open().catch((e: unknown) => e)
    expect(failure).not.toBeInstanceOf(DeviceGoneError)
  })

  it('a window that closes between frames reports gone on that very frame, not a capture error', async () => {
    let open = true
    const { device, tick } = bed('window://Simulator?id=43', {
      list: async () => (open ? screens : without(43)),
      windowAlive: async () => null,
      capture: async () => {
        if (!open) throw new Error('screencapture: could not create image from window')
      }
    })
    await device.open()
    await device.capture()
    open = false
    tick(10)
    await expect(device.capture()).rejects.toBeInstanceOf(DeviceGoneError)
  })

  it('gating is unchanged: input stays off, and the desk refuses first', async () => {
    const { device } = bed('window://Simulator?id=43', { remote: gate({ inputRefusal: () => INPUT_OFF }) })
    expect(device.inputRefusal()).toBe(INPUT_OFF)
    await expect(device.perform({ method: 'input.tap', params: { x: 1, y: 1 } } as never)).rejects.toThrow(INPUT_OFF)
    const denied = bed('window://Simulator?id=43', { remote: gate({ blocked: async () => blockedBy('needs-screen-recording') }) })
    await expect(denied.device.open()).rejects.toBeInstanceOf(DeviceBlockedError)
  })
})
