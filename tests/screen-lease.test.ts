import { describe, expect, it, vi } from 'vitest'
import { createScreenLeases, type LeasedScreen } from '../src/main/screen-lease'

/**
 * A SCREEN WATCHED OVER HTTP (owner 2026-11-10, design B): another machine of
 * the account enters as a named viewer, as a phone's viewer does, so the screen
 * looks while it is watched and its host lists who is on it; it leaves on its
 * own once the reads stop.
 */

const WHO = { key: 'device:solis', name: 'Solis-Core', here: false }

function screen(refused: string | null = null) {
  const left = vi.fn()
  const frameListeners = new Set<(jpeg: string) => void>()
  const instance = {
    frameListeners,
    refusalFor: vi.fn(() => (refused ? { state: 'offline', message: refused, use: 'computer', input: false } : null)),
    enterViewer: vi.fn(() => left),
    registerViewportViewer: vi.fn(),
    unregisterViewportViewer: vi.fn()
  }
  return { instance: instance as unknown as LeasedScreen, raw: instance, left, push: (jpeg: string) => frameListeners.forEach((l) => l(jpeg)) }
}

describe('createScreenLeases', () => {
  it('enters once as the caller, hands out the latest picture, and leaves after the reads stop', () => {
    vi.useFakeTimers()
    try {
      const leases = createScreenLeases(5000)
      const s = screen()
      expect(leases.look(s.instance, 's-1', WHO)).toEqual({ ok: true, jpeg: null })
      expect(s.raw.enterViewer).toHaveBeenCalledWith('http:device:solis:s-1', WHO)
      expect(s.raw.registerViewportViewer).toHaveBeenCalledWith('http:device:solis:s-1')
      s.push('AAAA')
      vi.advanceTimersByTime(4000)
      expect(leases.look(s.instance, 's-1', WHO)).toEqual({ ok: true, jpeg: 'AAAA' })
      expect(s.raw.enterViewer).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(4000)
      expect(s.left).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1500)
      expect(s.left).toHaveBeenCalledOnce()
      expect(s.raw.unregisterViewportViewer).toHaveBeenCalledWith('http:device:solis:s-1')
      expect(s.raw.frameListeners.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a caller the screen refuses gets its words and no viewer', () => {
    const leases = createScreenLeases(5000)
    const s = screen('Stopped at the Mac')
    expect(leases.look(s.instance, 's-1', WHO)).toEqual({ ok: false, message: 'Stopped at the Mac' })
    expect(s.raw.enterViewer).not.toHaveBeenCalled()
  })

  it('touch keeps a driver on the list as it drives', () => {
    vi.useFakeTimers()
    try {
      const leases = createScreenLeases(5000)
      const s = screen()
      leases.look(s.instance, 's-1', WHO)
      for (let i = 0; i < 4; i += 1) {
        vi.advanceTimersByTime(3000)
        expect(leases.touch(s.instance, 's-1', WHO)).toBe(true)
      }
      expect(s.left).not.toHaveBeenCalled()
      expect(s.raw.enterViewer).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
