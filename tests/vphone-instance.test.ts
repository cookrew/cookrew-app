// A VIRTUAL iPHONE AS A BROWSER INSTANCE: frames from the guest's own
// screenshots, input through its touch injection, the same cast on top.
import { describe, expect, it, vi } from 'vitest'
import { VphoneInstance, VPHONE_FAST_POLL_MS, VPHONE_IDLE_POLL_MS, VPHONE_HEARTBEAT_MS, VPHONE_EXIT_AFTER_FAILURES } from '../src/main/vphone-instance'
import type { VphoneGuest } from '../src/main/vphone-socket'

/** A guest whose screen is whatever the test says, and that remembers every call. */
const fakeGuest = (over: { screen?: () => unknown; ping?: () => boolean; fail?: (method: string) => boolean } = {}) => {
  const calls: Array<[string, unknown]> = []
  let shot = 'AAAA'
  const guest: VphoneGuest = {
    ping: async () => over.ping?.() ?? true,
    rpc: async (method, params) => {
      calls.push([method, params])
      if (over.fail?.(method)) throw new Error(`${method} failed`)
      if (method === 'device.screen') return over.screen?.() ?? { width: 430, height: 932, scale: 3 }
      if (method === 'screen.screenshot') return { data: shot, mime_type: 'image/jpeg', width: 1290, height: 2796 }
      if (method === 'apps.foreground') return { bundle_id: 'com.apple.mobilesafari', name: 'Safari' }
      return { ok: true }
    }
  }
  return { guest, calls, setShot: (next: string) => void (shot = next) }
}

const instance = (guest: VphoneGuest, machine = 'myphone') => new VphoneInstance({ machine, guest })

describe('starting', () => {
  it('reads the screen in points and reports a mobile viewport of that size', async () => {
    const { guest } = fakeGuest()
    const it1 = instance(guest)
    await it1.start()
    expect(it1.viewportState).toMatchObject({ width: 430, height: 932, mobile: true })
    await it1.stop()
  })

  it('derives points from the screenshot when device.screen says only pixels', async () => {
    const { guest } = fakeGuest({ screen: () => ({ width: 1290, height: 2796 }) })
    const it1 = instance(guest)
    await it1.start()
    expect(it1.viewport).toEqual({ width: 430, height: 932 })
    await it1.stop()
  })

  it('refuses to start a machine whose socket does not answer, saying how to launch it', async () => {
    const { guest } = fakeGuest({ ping: () => false })
    await expect(instance(guest).start()).rejects.toThrow(/vphone-cli vm launch myphone/)
  })
})

describe('frames', () => {
  it('polls screenshots and hands each new one to the listeners with the point size', async () => {
    vi.useFakeTimers()
    try {
      const { guest, setShot } = fakeGuest()
      const it1 = instance(guest)
      const frames: Array<[string, Record<string, unknown>]> = []
      it1.frameListeners.add((jpeg, meta) => frames.push([jpeg, meta as Record<string, unknown>]))
      await it1.start()
      await vi.advanceTimersByTimeAsync(VPHONE_IDLE_POLL_MS + 5)
      expect(frames).toHaveLength(1)
      expect(frames[0][0]).toBe('AAAA')
      expect(frames[0][1]).toMatchObject({ deviceWidth: 430, deviceHeight: 932, mobile: true })
      setShot('BBBB')
      await vi.advanceTimersByTimeAsync(VPHONE_IDLE_POLL_MS + 5)
      expect(frames.map((f) => f[0])).toEqual(['AAAA', 'BBBB'])
      await it1.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not repeat an unchanged frame except as a heartbeat', async () => {
    vi.useFakeTimers()
    try {
      const { guest } = fakeGuest()
      const it1 = instance(guest)
      let count = 0
      it1.frameListeners.add(() => count++)
      await it1.start()
      await vi.advanceTimersByTimeAsync(VPHONE_HEARTBEAT_MS * 3 + 50)
      // One first frame, then at most one heartbeat per heartbeat period.
      expect(count).toBeGreaterThanOrEqual(2)
      expect(count).toBeLessThanOrEqual(4)
      expect(VPHONE_HEARTBEAT_MS).toBeLessThan(1200)
      await it1.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls fast after input and settles back to idle', async () => {
    vi.useFakeTimers()
    try {
      const { guest, calls } = fakeGuest()
      const it1 = instance(guest)
      await it1.start()
      const shots = () => calls.filter(([m]) => m === 'screen.screenshot').length
      await vi.advanceTimersByTimeAsync(VPHONE_IDLE_POLL_MS * 3)
      const idle = shots()
      it1.dispatchInput('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10 })
      it1.dispatchInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10 })
      await vi.advanceTimersByTimeAsync(VPHONE_IDLE_POLL_MS)
      expect(shots() - idle).toBeGreaterThan(VPHONE_IDLE_POLL_MS / VPHONE_FAST_POLL_MS / 2)
      await it1.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not lose a fast look that was asked for while a screenshot was in flight', async () => {
    vi.useFakeTimers()
    try {
      // A guest whose screenshots take longer than the fast cadence.
      const gate = { release: null as null | (() => void), shots: 0 }
      const { guest } = fakeGuest()
      const slow: VphoneGuest = {
        ping: guest.ping,
        rpc: async (method, params) => {
          if (method === 'screen.screenshot') {
            gate.shots += 1
            await new Promise<void>((resolve) => void (gate.release = resolve))
          }
          return guest.rpc(method, params)
        }
      }
      const it1 = instance(slow)
      await it1.start()
      await vi.advanceTimersByTimeAsync(VPHONE_IDLE_POLL_MS + 5)
      expect(gate.shots).toBe(1)
      // The first poll is in flight. An input asks for a fast look.
      it1.dispatchInput('Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10 })
      it1.dispatchInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10 })
      await vi.advanceTimersByTimeAsync(VPHONE_FAST_POLL_MS + 5)
      expect(gate.shots).toBe(1)
      gate.release?.()
      await vi.advanceTimersByTimeAsync(VPHONE_FAST_POLL_MS + 5)
      // The fast look asked for during the slow one happens right after it.
      expect(gate.shots).toBe(2)
      gate.release?.()
      await it1.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('exits after the guest stops answering', async () => {
    vi.useFakeTimers()
    try {
      let broken = false
      const { guest } = fakeGuest({ fail: (m) => broken && m === 'screen.screenshot' })
      const it1 = instance(guest)
      const exited = vi.fn()
      it1.onExit = exited
      await it1.start()
      broken = true
      await vi.advanceTimersByTimeAsync(VPHONE_IDLE_POLL_MS * (VPHONE_EXIT_AFTER_FAILURES + 2))
      expect(exited).toHaveBeenCalledTimes(1)
      await it1.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('snapshot is the latest frame', async () => {
    vi.useFakeTimers()
    try {
      const { guest } = fakeGuest()
      const it1 = instance(guest)
      await it1.start()
      expect(await it1.snapshot()).toBeNull()
      await vi.advanceTimersByTimeAsync(VPHONE_IDLE_POLL_MS + 5)
      expect(await it1.snapshot()).toBe('AAAA')
      await it1.stop()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('input and navigation', () => {
  it('turns the cast’s CDP literals into vphoned input calls', async () => {
    const { guest, calls } = fakeGuest()
    const it1 = instance(guest)
    await it1.start()
    it1.dispatchInput('Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 200 })
    it1.dispatchInput('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 100, y: 200 })
    it1.dispatchInput('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter' })
    await vi.waitFor(() => expect(calls.filter(([m]) => m.startsWith('input.'))).toHaveLength(2))
    expect(calls.filter(([m]) => m.startsWith('input.'))).toEqual([
      ['input.tap', { x: 100, y: 200 }],
      ['input.key', { name: 'return' }]
    ])
    await it1.stop()
  })

  it('navigates a web address through Safari and a vphone address through launch', async () => {
    const { guest, calls } = fakeGuest()
    const it1 = instance(guest)
    await it1.start()
    await it1.navigate('https://example.test/page')
    await it1.navigate('vphone://myphone/com.apple.Preferences')
    expect(calls.filter(([m]) => m.startsWith('apps.'))).toEqual([
      ['apps.open_url', { url: 'https://example.test/page' }],
      ['apps.launch', { bundle_id: 'com.apple.Preferences' }]
    ])
    await expect(it1.navigate('ftp://nope')).rejects.toThrow(/http/)
    await expect(it1.navigate('vphone://other/com.x')).rejects.toThrow(/other/)
    await it1.stop()
  })

  it('reports the front app as the page, and refuses to evaluate script', async () => {
    const { guest } = fakeGuest()
    const it1 = instance(guest)
    await it1.start()
    expect(await it1.pageInfo()).toEqual({ url: 'vphone://myphone/com.apple.mobilesafari', title: 'Safari', viewport: '430x932' })
    await expect(it1.evaluate('1+1')).rejects.toThrow(/not a web page/)
    await it1.stop()
  })

  it('is indifferent to tab sync and resize, and has no process of its own', async () => {
    const { guest } = fakeGuest()
    const it1 = instance(guest)
    await it1.start()
    await it1.syncTabs([{ id: 't', url: 'vphone://myphone', title: '' }], 't')
    await it1.resize(1000, 1000)
    expect(it1.viewport).toEqual({ width: 430, height: 932 })
    expect(it1.processId).toBeNull()
    expect(await it1.stop()).toEqual({ pid: null, forced: false })
  })
})
