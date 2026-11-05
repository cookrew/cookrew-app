// A phone's own workspace (bug 10): kept on the device, carried on every
// request, and given up the moment that workspace has gone.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const memory = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key)
})

const load = async () => {
  vi.resetModules()
  return import('../src/renderer/src/device-seat')
}

const list = (...ids: string[]) => ({ workspaces: ids.map((id) => ({ id })) })

describe('the device seat', () => {
  beforeEach(() => memory.clear())

  it('has none until the phone chooses', async () => {
    const seat = await load()
    expect(seat.deviceSeat()).toBeNull()
    expect(seat.seated('/api/workspace')).toBe('/api/workspace')
  })

  it('rides on every path, after any query the path already has', async () => {
    const seat = await load()
    seat.takeSeat('w 1')
    expect(seat.seated('/api/workspace')).toBe('/api/workspace?seat=w%201')
    expect(seat.seated('/api/events?boot=x')).toBe('/api/events?boot=x&seat=w%201')
  })

  it('survives a reload on this device', async () => {
    ;(await load()).takeSeat('w1')
    expect((await load()).deviceSeat()).toBe('w1')
  })

  it('is given up when its workspace has gone, and says so once', async () => {
    const seat = await load()
    seat.takeSeat('w1')
    expect(seat.settleSeat(list('w1', 'w2'))).toBe(false)
    expect(seat.settleSeat(list('w2'))).toBe(true)
    expect(seat.deviceSeat()).toBeNull()
    expect(seat.settleSeat(list('w2'))).toBe(false)
  })
})
