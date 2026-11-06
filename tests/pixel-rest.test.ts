// A SCREEN NOBODY IS USING IS NOT BEING READ (main/pixel-instance.ts). A window card
// holds whatever the owner has open, so with no viewer it takes no frames at all: an
// agent's look takes one, and a card left alone ends its session and holds nothing.
import { describe, expect, it, vi } from 'vitest'
import { parseUseUrl } from '../src/shared/use-url'
import type { RemoteState } from '../src/shared/remote-access'
import { DeviceBlockedError, DeviceGoneError, PIXEL_FAST_POLL_MS, PIXEL_SESSION_IDLE_MS, PixelInstance, type PixelDevice, type RemoteGate } from '../src/main/pixel-instance'
import type { Gesture } from '../src/main/vphone-input'

const settle = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function rig(url = 'window://WeChat?id=7', over: Partial<RemoteGate> = {}) {
  let now = 1_000
  const timers: Array<{ fn: () => void; ms: number; live: boolean }> = []
  const state = { frame: 'AAA', subject: 7, fail: null as Error | null, captures: 0, opens: 0, rests: 0, gestures: [] as Gesture[], blocked: null as RemoteState | null }
  const remote: RemoteGate = {
    blocked: async () => state.blocked,
    inputRefusal: () => null,
    agentRefusal: () => null,
    mayDrive: () => true,
    cardControl: () => ({ switchOn: true, until: null, heldBy: null, awake: false, machine: 'darwin' }),
    admit: () => null,
    enter: () => () => undefined,
    ...over
  }
  const device: PixelDevice = {
    target: parseUseUrl(url)!,
    remote,
    open: async () => {
      if (state.fail) throw state.fail
      state.opens += 1
      return { width: 1000, height: 800 }
    },
    capture: async () => {
      if (state.fail) throw state.fail
      state.captures += 1
      return { jpeg: state.frame, subject: state.subject }
    },
    perform: async (g) => {
      if (state.fail) throw state.fail
      state.gestures.push(g)
    },
    rest: () => {
      state.rests += 1
    }
  }
  const onRest = vi.fn()
  const onBlocked = vi.fn()
  const instance = new PixelInstance({
    url,
    device,
    now: () => now,
    onRest,
    onBlocked,
    schedule: (fn, ms) => {
      const timer = { fn, ms, live: true }
      timers.push(timer)
      return () => {
        timer.live = false
      }
    }
  })
  const pending = () => timers.filter((t) => t.live)
  return {
    state,
    instance,
    onRest,
    onBlocked,
    pending,
    /** Fires what is due within `ms`, as the clock would. */
    async pass(ms: number): Promise<void> {
      now += ms
      for (const timer of pending().filter((t) => t.ms <= ms)) {
        timer.live = false
        timer.fn()
      }
      await settle()
    },
    watch(id = 'v1') {
      const listener = (): void => undefined
      instance.registerViewportViewer(id)
      instance.frameListeners.add(listener)
      return () => {
        instance.frameListeners.delete(listener)
        instance.unregisterViewportViewer(id)
      }
    }
  }
}

const tap: Gesture = { method: 'input.tap', params: { x: 5, y: 5 } }

describe('nobody watching', () => {
  it('takes no frame at all, from the moment the card exists', async () => {
    const r = rig()
    await r.instance.start()
    await r.pass(3_600_000)
    expect(r.state.captures).toBe(0)
    expect(r.state.opens).toBe(0)
    expect(r.pending()).toEqual([])
    expect(r.instance.status.state).toBe('resting')
  })

  it('stops the moment the last viewer leaves, and no timer goes on looking', async () => {
    const r = rig()
    await r.instance.start()
    const leave = r.watch()
    await r.pass(PIXEL_FAST_POLL_MS)
    expect(r.state.captures).toBe(1)
    leave()
    const seen = r.state.captures
    await r.pass(PIXEL_SESSION_IDLE_MS - 1)
    expect(r.state.captures).toBe(seen)
  })

  it('a second viewer leaving does not stop the first', async () => {
    const r = rig()
    await r.instance.start()
    r.watch('a')
    const leave = r.watch('b')
    await r.pass(PIXEL_FAST_POLL_MS)
    leave()
    const seen = r.state.captures
    await r.pass(1000)
    expect(r.state.captures).toBeGreaterThan(seen)
  })

  it('wake() does not look: a lock lifting is no reason to read a card nobody has open', async () => {
    const r = rig()
    await r.instance.start()
    r.instance.wake()
    await r.pass(1000)
    expect(r.state.captures).toBe(0)
  })

  it('a card with no desk behind it, a phone or a camera, keeps its slow frames for its thumbnail', async () => {
    const device: PixelDevice = { target: parseUseUrl('adb://default')!, open: async () => ({ width: 1, height: 1 }), capture: async () => ({ jpeg: 'A' }) }
    const scheduled: number[] = []
    const instance = new PixelInstance({ url: 'adb://default', device, schedule: (_fn, ms) => (scheduled.push(ms), () => undefined) })
    await instance.start()
    expect(instance.status.state).toBe('live')
    expect(scheduled.length).toBeGreaterThan(0)
  })
})

describe('an agent looks', () => {
  it('takes one frame for that look, and leaves no loop behind', async () => {
    const r = rig()
    await r.instance.start()
    expect(await r.instance.look()).toBe('AAA')
    expect(r.state.captures).toBe(1)
    await r.pass(PIXEL_SESSION_IDLE_MS - 1)
    expect(r.state.captures).toBe(1)
  })

  it('sees the screen as it is now, not as it was', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    r.state.frame = 'BBB'
    expect(await r.instance.look()).toBe('BBB')
  })

  it('two looks at once each get a frame', async () => {
    const r = rig()
    await r.instance.start()
    expect(await Promise.all([r.instance.look(), r.instance.look()])).toEqual(['AAA', 'AAA'])
  })

  it('reads the viewers\' frame when somebody is watching: no second capture', async () => {
    const r = rig()
    await r.instance.start()
    r.watch()
    await r.pass(PIXEL_FAST_POLL_MS)
    const seen = r.state.captures
    expect(await r.instance.look()).toBe('AAA')
    expect(r.state.captures).toBe(seen)
  })

  it('snapshot never captures: thumbnails poll it', async () => {
    const r = rig()
    await r.instance.start()
    expect(await r.instance.snapshot()).toBeNull()
    expect(r.state.captures).toBe(0)
  })

  it('after Stop it takes nothing, and says Stop: not that it will reconnect', async () => {
    const r = rig('window://WeChat?id=7', { admit: () => ({ message: 'Stopped at the Mac', state: {} as RemoteState }) })
    await r.instance.start()
    await expect(r.instance.look()).rejects.toThrow('Stopped at the Mac')
    expect(r.state.captures).toBe(0)
  })

  it('a Stop that lands during the look still gives no picture', async () => {
    let stopped = false
    const r = rig('window://WeChat?id=7', { admit: () => (stopped ? { message: 'Stopped at the Mac', state: {} as RemoteState } : null) })
    await r.instance.start()
    const device = (r.instance as unknown as { opts: { device: PixelDevice } }).opts.device
    const capture = device.capture.bind(device)
    device.capture = async () => {
      stopped = true
      return capture()
    }
    await expect(r.instance.look()).rejects.toThrow('Stopped at the Mac')
    expect(await r.instance.snapshot()).toBeNull()
  })

  it('a watched card that cannot be read gives no old picture', async () => {
    const r = rig()
    await r.instance.start()
    r.watch()
    await settle()
    r.state.fail = new Error('gone for a moment')
    await r.pass(1000)
    expect(await r.instance.look()).toBeNull()
  })
})

describe('the session ends by itself', () => {
  it('after the agent stops: nothing held, the device let go, and the owner of the hand told', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    await r.pass(PIXEL_SESSION_IDLE_MS)
    expect(r.instance.status.state).toBe('resting')
    expect(await r.instance.snapshot()).toBeNull()
    expect(r.state.rests).toBe(1)
    expect(r.onRest).toHaveBeenCalledTimes(1)
    expect(r.onBlocked).toHaveBeenCalled()
    expect(r.pending()).toEqual([])
  })

  it('every use puts it off', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    await r.pass(PIXEL_SESSION_IDLE_MS - 1000)
    await r.instance.act([tap])
    expect(r.pending().length).toBe(1)
    await r.pass(PIXEL_SESSION_IDLE_MS - 1000)
    expect(r.instance.status.state).toBe('live')
  })

  it('never while somebody is watching', async () => {
    const r = rig()
    await r.instance.start()
    r.watch()
    await r.pass(PIXEL_FAST_POLL_MS)
    await r.pass(PIXEL_SESSION_IDLE_MS)
    expect(r.instance.status.state).toBe('live')
  })

  it('when the last viewer has been gone that long', async () => {
    const r = rig()
    await r.instance.start()
    const leave = r.watch()
    await r.pass(PIXEL_FAST_POLL_MS)
    leave()
    await r.pass(PIXEL_SESSION_IDLE_MS)
    expect(r.instance.status.state).toBe('resting')
  })

  it('not in the middle of a gesture: it waits for the hand', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    let finish = (): void => undefined
    const slow = new Promise<void>((resolve) => (finish = resolve))
    const opts = r.instance as unknown as { opts: { device: PixelDevice } }
    opts.opts.device.perform = () => slow
    const acting = r.instance.act([tap])
    await r.pass(PIXEL_SESSION_IDLE_MS)
    expect(r.instance.status.state).toBe('live')
    finish()
    await acting
    await r.pass(PIXEL_SESSION_IDLE_MS)
    expect(r.instance.status.state).toBe('resting')
  })

  it('an offline card rests too: a closed window is not a reason to keep trying', async () => {
    const r = rig()
    await r.instance.start()
    r.state.fail = new DeviceGoneError('window', 'closed')
    await r.instance.look()
    expect(r.instance.status.state).toBe('offline')
    await r.pass(PIXEL_SESSION_IDLE_MS)
    expect(r.instance.status.state).toBe('resting')
    expect(r.pending()).toEqual([])
  })

  it('stop ends the countdown, and lets go of what the session held', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    await r.instance.stop()
    expect(r.pending()).toEqual([])
    expect(r.onRest).toHaveBeenCalledTimes(1)
  })
})

describe('the next use reconnects', () => {
  it('an agent looks and the card is live again, opened afresh', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    await r.pass(PIXEL_SESSION_IDLE_MS)
    r.state.frame = 'BBB'
    expect(await r.instance.look()).toBe('BBB')
    expect(r.state.opens).toBe(2)
    expect(r.instance.status.state).toBe('live')
  })

  it('a viewer arriving wakes it, and never reads a resting card as offline', async () => {
    const r = rig()
    await r.instance.start()
    r.watch()
    expect(r.instance.status.state).toBe('connecting')
    await settle()
    expect(r.instance.status.state).toBe('live')
    expect(r.state.captures).toBe(1)
  })

  it('a hand with no look since the session ended is refused, and nothing is pressed: the screen may have moved on', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    await r.pass(PIXEL_SESSION_IDLE_MS)
    await expect(r.instance.act([tap])).rejects.toThrow(/screenshot/)
    expect(r.state.gestures).toEqual([])
    await r.instance.look()
    await r.instance.act([tap])
    expect(r.state.gestures).toHaveLength(1)
  })

  it('the very first hand after a launch is refused the same way', async () => {
    const r = rig()
    await r.instance.start()
    await expect(r.instance.act([tap])).rejects.toThrow(/screenshot/)
  })
})

describe('the agent has to have seen it', () => {
  it('somebody else looking does not count: the agent saw nothing', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    await r.pass(PIXEL_SESSION_IDLE_MS)
    const leave = r.watch()
    await settle()
    leave()
    expect(r.instance.status.state).toBe('live')
    await expect(r.instance.act([tap])).rejects.toThrow(/screenshot/)
    expect(r.state.gestures).toEqual([])
  })

  it('a different window under the card since the look: look again', async () => {
    const r = rig()
    await r.instance.start()
    r.watch()
    await settle()
    await r.instance.look()
    r.state.subject = 8
    await r.pass(1000)
    await expect(r.instance.act([tap])).rejects.toThrow(/screenshot/)
    await r.instance.look()
    await r.instance.act([tap])
    expect(r.state.gestures).toHaveLength(1)
  })

  it('a look that failed is not a look', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    r.state.fail = new Error('covered')
    await r.instance.look()
    r.state.fail = null
    await expect(r.instance.act([tap])).rejects.toThrow(/screenshot/)
  })
})

describe('status', () => {
  it('asks the device when nothing is polling: a closed app does not read live', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    r.state.fail = new DeviceGoneError('window', 'has closed')
    await r.instance.check()
    expect(r.instance.status.state).toBe('offline')
  })

  it('wakes nothing, and is not a look', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.check()
    expect(r.instance.status.state).toBe('resting')
    expect(r.state.captures).toBe(0)
    expect(r.instance.status.message).toMatch(/screenshot/)
  })

  it('after a session lapses on status alone the hand still needs a look', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.check()
    await expect(r.instance.act([tap])).rejects.toThrow(/screenshot/)
  })
})

describe('a viewer that went away without leaving', () => {
  it('a hidden page is not watching: no frames until it comes back', async () => {
    const r = rig()
    await r.instance.start()
    r.watch()
    await settle()
    r.instance.viewerHidden('v1', true)
    const seen = r.state.captures
    await r.pass(5000)
    expect(r.state.captures).toBe(seen)
    expect(r.pending().every((t) => t.ms === PIXEL_SESSION_IDLE_MS)).toBe(true)
  })

  it('comes back to a frame at once, even from rest', async () => {
    const r = rig()
    await r.instance.start()
    r.watch()
    await settle()
    r.instance.viewerHidden('v1', true)
    await r.pass(PIXEL_SESSION_IDLE_MS)
    expect(r.instance.status.state).toBe('resting')
    const seen = r.state.captures
    r.instance.viewerHidden('v1', false)
    await settle()
    expect(r.instance.status.state).toBe('live')
    expect(r.state.captures).toBeGreaterThan(seen)
  })

  it('one hidden viewer does not stop one still looking', async () => {
    const r = rig()
    await r.instance.start()
    r.watch('a')
    r.watch('b')
    await settle()
    r.instance.viewerHidden('a', true)
    const seen = r.state.captures
    await r.pass(1000)
    expect(r.state.captures).toBeGreaterThan(seen)
  })

  it('a viewer that never offered is watching', async () => {
    const r = rig()
    await r.instance.start()
    r.watch()
    await settle()
    const seen = r.state.captures
    await r.pass(1000)
    expect(r.state.captures).toBeGreaterThan(seen)
  })
})

describe('the app behind the card closes', () => {
  it('mid-way, under an agent: the tap fails in words and nothing lands elsewhere', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    r.state.fail = new DeviceGoneError('window', "The 'WeChat' window this card showed has closed")
    await expect(r.instance.act([tap])).rejects.toThrow(/closed/)
    expect(r.state.gestures).toEqual([])
  })

  it('mid-way, the look says why and shows no old picture', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    r.state.fail = new DeviceGoneError('window', "The 'WeChat' window this card showed has closed")
    expect(await r.instance.look()).toBeNull()
    expect(r.instance.status.message).toMatch(/closed/)
    expect(r.instance.status.gone).toBe('window')
  })

  it('after use: the card sleeps through it, and the next look says what happened', async () => {
    const r = rig()
    await r.instance.start()
    await r.instance.look()
    await r.pass(PIXEL_SESSION_IDLE_MS)
    r.state.fail = new DeviceGoneError('window', "The 'WeChat' window this card showed has closed")
    await r.pass(3_600_000)
    expect(r.state.captures).toBe(1)
    expect(await r.instance.look()).toBeNull()
    expect(r.instance.status.message).toMatch(/closed/)
  })

  it('back again, the same look reconnects', async () => {
    const r = rig()
    await r.instance.start()
    r.state.fail = new DeviceGoneError('window', 'closed')
    expect(await r.instance.look()).toBeNull()
    r.state.fail = null
    expect(await r.instance.look()).toBe('AAA')
    expect(r.instance.status.gone).toBeUndefined()
  })

  it('a locked Mac gives no frame, and no look is left waiting on it', async () => {
    const r = rig()
    await r.instance.start()
    r.state.fail = new DeviceBlockedError({ id: 'locked', platform: 'darwin', then: null, detail: null, lastSeenAt: null, until: null, waiting: false, build: { settingsName: 'Cookrew', sourceBuild: false, restart: 'self', agents: 'keep' } } as RemoteState)
    expect(await r.instance.look()).toBeNull()
    expect(r.pending().length).toBe(1)
  })
})
