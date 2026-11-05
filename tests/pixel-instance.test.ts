// A SCREEN THE AGENT USES (main/pixel-instance.ts): a device that fails is
// offline-and-retrying, never an exit; frames flow on cadence; input reaches
// the device in points, and a device that refuses input refuses it in words.
import { describe, expect, it, vi } from 'vitest'
import type { UseStatus } from '../src/shared/use-signal'
import { parseUseUrl } from '../src/shared/use-url'
import {
  DeviceGoneError,
  PIXEL_FAST_POLL_MS,
  PIXEL_GONE_POLL_MS,
  PIXEL_HEARTBEAT_MS,
  PIXEL_IDLE_POLL_MS,
  PIXEL_MAX_BACKOFF_MS,
  PIXEL_OPEN_TIMEOUT_MS,
  PIXEL_UNWATCHED_POLL_MS,
  PixelInstance,
  type PixelDevice
} from '../src/main/pixel-instance'
import type { Gesture } from '../src/main/vphone-input'

/** A clock and a scheduler the test turns by hand: run() fires the one pending tick. */
function manual() {
  let now = 1_000
  let pending: { fn: () => void; ms: number } | null = null
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      pending = { fn, ms }
      return () => {
        if (pending?.fn === fn) pending = null
      }
    },
    get due(): number | null {
      return pending?.ms ?? null
    },
    async run(): Promise<void> {
      const next = pending
      if (!next) throw new Error('nothing scheduled')
      pending = null
      now += next.ms
      next.fn()
      await new Promise((r) => setTimeout(r, 0))
      await new Promise((r) => setTimeout(r, 0))
    },
    advance(ms: number) {
      now += ms
    }
  }
}

function fakeDevice(kind = 'adb://default') {
  const state = { attached: true, frame: 'AAA', input: true, refusal: null as string | null, opened: 0, gestures: [] as Gesture[] }
  const device: PixelDevice = {
    target: parseUseUrl(kind)!,
    open: async () => {
      if (!state.attached) throw new Error('No Android device is attached')
      state.opened += 1
      return { width: 400, height: 800 }
    },
    capture: async () => {
      if (!state.attached) throw new Error('adb: device not found')
      return { jpeg: state.frame }
    },
    perform: async (g) => {
      state.gestures.push(g)
    },
    inputRefusal: () => state.refusal
  }
  return { state, device }
}

describe('PixelInstance', () => {
  it('opens offline when the device is away, says why, backs off, and comes back live to the same viewers', async () => {
    const clock = manual()
    const { state, device } = fakeDevice()
    state.attached = false
    const instance = new PixelInstance({ url: 'adb://default', device, now: clock.now, schedule: clock.schedule })
    const statuses: UseStatus[] = []
    const frames: string[] = []
    let exited = false
    instance.onExit = () => {
      exited = true
    }
    instance.statusListeners.add((s) => statuses.push(s))
    instance.frameListeners.add((jpeg) => frames.push(jpeg))

    await instance.start()
    expect(instance.status).toMatchObject({ state: 'offline', message: 'No Android device is attached' })
    expect(clock.due).toBe(PIXEL_IDLE_POLL_MS)
    await clock.run()
    expect(clock.due).toBe(PIXEL_IDLE_POLL_MS * 2)
    for (let i = 0; i < 6; i += 1) await clock.run()
    expect(clock.due).toBe(PIXEL_MAX_BACKOFF_MS)
    expect(exited).toBe(false)
    expect(frames).toEqual([])

    state.attached = true
    await clock.run()
    expect(instance.status.state).toBe('live')
    expect(frames).toEqual(['AAA'])
    expect(clock.due).toBe(PIXEL_IDLE_POLL_MS)
    // One status per change, not per tick.
    expect(statuses.map((s) => s.state)).toEqual(['offline', 'live'])
    // Pulled again mid-stream: offline, then reopened on return.
    state.attached = false
    await clock.run()
    expect(instance.status.state).toBe('offline')
    state.attached = true
    await clock.run()
    expect(instance.status.state).toBe('live')
    expect(state.opened).toBe(2)
    expect(exited).toBe(false)
    await instance.stop()
  })

  it('idles at one frame every few seconds while nobody watches, and wakes for a viewer', async () => {
    const clock = manual()
    const { device } = fakeDevice()
    const instance = new PixelInstance({ url: 'adb://default', device, now: clock.now, schedule: clock.schedule })
    await instance.start()
    expect(clock.due).toBe(PIXEL_UNWATCHED_POLL_MS)
    instance.frameListeners.add(() => undefined)
    instance.registerViewportViewer('phone')
    expect(clock.due).toBe(PIXEL_FAST_POLL_MS)
    await clock.run()
    expect(clock.due).toBe(PIXEL_IDLE_POLL_MS)
    await instance.stop()
  })

  it('sends a changed frame at once and an unchanged one only on the heartbeat', async () => {
    const clock = manual()
    const { state, device } = fakeDevice()
    const instance = new PixelInstance({ url: 'adb://default', device, now: clock.now, schedule: clock.schedule })
    const frames: string[] = []
    instance.frameListeners.add((jpeg) => frames.push(jpeg))
    await instance.start()
    expect(frames).toEqual(['AAA'])
    await clock.run() // +800 ms ≥ heartbeat: resent
    expect(frames).toHaveLength(2)
    state.frame = 'BBB'
    await clock.run()
    expect(frames.at(-1)).toBe('BBB')
    expect(PIXEL_HEARTBEAT_MS).toBeLessThan(PIXEL_IDLE_POLL_MS + 1)
    await instance.stop()
  })

  it('maps a viewer tap to a device tap in points and polls fast after it', async () => {
    const clock = manual()
    const { state, device } = fakeDevice()
    const instance = new PixelInstance({ url: 'adb://default', device, now: clock.now, schedule: clock.schedule })
    await instance.start()
    instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 200, button: 'left', clickCount: 1 })
    instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 101, y: 201, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 0))
    expect(state.gestures).toEqual([{ method: 'input.tap', params: { x: 101, y: 201 } }])
    expect(clock.due).toBe(PIXEL_FAST_POLL_MS)
    await instance.stop()
  })

  it('a computer card scrolls its wheel; a phone card swipes it', async () => {
    for (const [url, method] of [
      ['screen://main', 'input.scroll'],
      ['adb://default', 'input.swipe']
    ] as const) {
      const clock = manual()
      const { state, device } = fakeDevice(url)
      const instance = new PixelInstance({ url, device, now: clock.now, schedule: clock.schedule })
      await instance.start()
      instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 50, y: 50, deltaX: 0, deltaY: 120 })
      await new Promise((r) => setTimeout(r, 0))
      expect(state.gestures[0]?.method, url).toBe(method)
      await instance.stop()
    }
  })

  it('a device that refuses input drops viewer input and tells the agent why', async () => {
    const clock = manual()
    const { state, device } = fakeDevice('screen://main')
    state.refusal = 'Driving this Mac is off'
    const instance = new PixelInstance({ url: 'screen://main', device, now: clock.now, schedule: clock.schedule })
    await instance.start()
    expect(instance.status).toMatchObject({ state: 'live', input: false })
    instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 })
    instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 })
    await expect(instance.act([{ method: 'input.tap', params: { x: 1, y: 1 } }])).rejects.toThrow('Driving this Mac is off')
    expect(state.gestures).toEqual([])
    await instance.stop()
  })

  it('calls the device as a method, so a class device keeps its own state', async () => {
    const clock = manual()
    const seen: string[] = []
    class SerialDevice {
      readonly target = parseUseUrl('adb://default')!
      private readonly serial = 'R58M'
      async open() {
        return { width: 10, height: 10 }
      }
      async capture() {
        return { jpeg: 'A' }
      }
      async perform(_g: Gesture) {
        seen.push(this.serial)
      }
    }
    const instance = new PixelInstance({ url: 'adb://default', device: new SerialDevice(), now: clock.now, schedule: clock.schedule })
    await instance.start()
    await instance.act([{ method: 'input.tap', params: { x: 1, y: 1 } }])
    instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 })
    instance.dispatchInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1, y: 1, button: 'left', clickCount: 1 })
    await instance.act([])
    expect(seen).toEqual(['R58M', 'R58M'])
    await instance.stop()
  })

  it('act resolves once the device took every gesture, in order, and surfaces a failure', async () => {
    const clock = manual()
    const { state, device } = fakeDevice()
    const instance = new PixelInstance({ url: 'adb://default', device, now: clock.now, schedule: clock.schedule })
    await instance.start()
    await instance.act([
      { method: 'input.tap', params: { x: 1, y: 2 } },
      { method: 'input.type', params: { text: 'hi' } }
    ])
    expect(state.gestures.map((g) => g.method)).toEqual(['input.tap', 'input.type'])
    device.perform = async () => {
      throw new Error('adb: closed')
    }
    await expect(instance.act([{ method: 'input.tap', params: { x: 1, y: 2 } }])).rejects.toThrow('adb: closed')
    await instance.stop()
  })

  it('a screen is not a page: evaluate refuses in words, and the size is the device’s', async () => {
    const clock = manual()
    const { device } = fakeDevice()
    const instance = new PixelInstance({ url: 'adb://default', device, now: clock.now, schedule: clock.schedule })
    await instance.start()
    await expect(instance.evaluate('1')).rejects.toThrow(/screen, not a web page/)
    expect(instance.viewport).toEqual({ width: 400, height: 800 })
    expect(await instance.snapshot()).toBe('AAA')
    expect(instance.claimViewport('v', { width: 1, height: 1, mobile: false })).toBe(false)
    await instance.stop()
    expect(clock.due).toBeNull()
  })

  it('a device that never answers is offline with a reason, not connecting forever', async () => {
    vi.useFakeTimers()
    try {
      const { device } = fakeDevice()
      device.open = () => new Promise(() => undefined)
      const instance = new PixelInstance({ url: 'adb://default', device })
      const started = instance.start()
      await vi.advanceTimersByTimeAsync(PIXEL_OPEN_TIMEOUT_MS + 1)
      await started
      expect(instance.status).toMatchObject({ state: 'offline', message: 'the device did not answer in 15 s' })
      await instance.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PixelInstance · a device that is gone for good', () => {
  const gone = () => {
    const clock = manual()
    let alive = false
    const opened = { count: 0 }
    const device: PixelDevice = {
      target: parseUseUrl('window://Safari?id=4')!,
      open: async () => {
        opened.count += 1
        if (!alive) throw new DeviceGoneError('window', "'Safari' closed")
        return { width: 100, height: 100 }
      },
      capture: async () => ({ jpeg: 'AAA' })
    }
    const instance = new PixelInstance({ url: 'window://Safari?id=4', device, now: clock.now, schedule: clock.schedule })
    return { clock, instance, opened, revive: () => (alive = true) }
  }

  it('tells its viewers it is gone, and stops spending a helper process every few seconds on it', async () => {
    const { clock, instance } = gone()
    await instance.start()
    expect(instance.status).toMatchObject({ state: 'offline', message: "'Safari' closed", gone: 'window' })
    expect(clock.due).toBe(PIXEL_GONE_POLL_MS)
  })

  it('is still a card: a viewer arriving looks again, and a device back is live with gone cleared', async () => {
    const { clock, instance, opened, revive } = gone()
    await instance.start()
    instance.registerViewportViewer('v1')
    expect(clock.due).toBe(PIXEL_FAST_POLL_MS)
    await clock.run()
    expect(opened.count).toBe(2)
    revive()
    await clock.run()
    expect(instance.status.state).toBe('live')
    expect(instance.status.gone).toBeUndefined()
  })

  it('an ordinary failure carries no gone', async () => {
    const { state, device } = fakeDevice()
    state.attached = false
    const clock = manual()
    const instance = new PixelInstance({ url: 'adb://default', device, now: clock.now, schedule: clock.schedule })
    await instance.start()
    expect(instance.status.gone).toBeUndefined()
  })
})
