// WHAT THE PHONE SAYS ABOUT ITS OWN NETWORK (path/radio.ts).
// Android Chrome names the network type; a move from Wi-Fi to 5G changes it
// and fires no `online`. The bandwidth estimate changes all the time and is
// not a move.
import { describe, expect, it, vi } from 'vitest'
import { leaveDirectPlane, onCellular, watchNetworkMoves, type ConnectionLike } from '../src/renderer/src/path/radio'
import type { DataPlane } from '../src/renderer/src/data-plane'

/** A navigator.connection stand-in: a type, and a 'change' event to fire. */
const fakeConnection = (type?: string): ConnectionLike & { fire: () => void } => {
  const target = new EventTarget()
  const connection = {
    type,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    fire: () => void target.dispatchEvent(new Event('change'))
  }
  return connection
}

/** window's online/offline, as a stand-in. */
const fakeWindow = (): { on: (event: string, cb: () => void) => () => void; fire: (event: string) => void } => {
  const target = new EventTarget()
  return {
    on: (event, cb) => {
      target.addEventListener(event, cb)
      return () => target.removeEventListener(event, cb)
    },
    fire: (event) => void target.dispatchEvent(new Event(event))
  }
}

describe('is this phone on a radio', () => {
  it('reads cellular off the connection, and only that', () => {
    expect(onCellular(fakeConnection('cellular'))).toBe(true)
    expect(onCellular(fakeConnection('wifi'))).toBe(false)
    // Safari and desktop Chrome name no type: not a radio, race as before.
    expect(onCellular(fakeConnection(undefined))).toBe(false)
    expect(onCellular(undefined)).toBe(false)
  })
})

describe('watching for a move between networks', () => {
  it('fires when the type changes, and not for a new bandwidth estimate', () => {
    const connection = fakeConnection('wifi')
    const moved = vi.fn()
    const off = watchNetworkMoves(moved, { connection, on: fakeWindow().on })
    connection.fire()
    expect(moved).not.toHaveBeenCalled()
    connection.type = 'cellular'
    connection.fire()
    expect(moved).toHaveBeenCalledTimes(1)
    connection.fire()
    expect(moved).toHaveBeenCalledTimes(1)
    off()
    connection.type = 'wifi'
    connection.fire()
    expect(moved).toHaveBeenCalledTimes(1)
  })

  it('fires on online and offline, where no type is named', () => {
    const win = fakeWindow()
    const moved = vi.fn()
    const off = watchNetworkMoves(moved, { connection: undefined, on: win.on })
    win.fire('offline')
    win.fire('online')
    expect(moved).toHaveBeenCalledTimes(2)
    off()
    win.fire('online')
    expect(moved).toHaveBeenCalledTimes(2)
  })
})

describe('leaving a direct plane when the network moved', () => {
  const RTC: DataPlane = { origin: '', kind: 'lan', transport: 'rtc' }
  const NAME: DataPlane = { origin: 'https://192-168-2-13.x.d.cookrew.dev:8643', kind: 'lan' }
  const RELAY: DataPlane = { origin: '', kind: 'relay' }

  it('closes the link, which takes the plane back to the relay', () => {
    const close = vi.fn()
    const fallBack = vi.fn()
    expect(leaveDirectPlane({ plane: () => RTC, link: () => ({ close }), fallBack }, 'the network changed')).toBe(true)
    expect(close).toHaveBeenCalledWith('the network changed')
    // A link that was already gone still leaves the plane on the relay.
    expect(fallBack).toHaveBeenCalled()
  })

  it('drops a direct name back to the relay', () => {
    const fallBack = vi.fn()
    expect(leaveDirectPlane({ plane: () => NAME, link: () => null, fallBack }, 'the network changed')).toBe(true)
    expect(fallBack).toHaveBeenCalledTimes(1)
  })

  it('leaves the relay alone', () => {
    const fallBack = vi.fn()
    expect(leaveDirectPlane({ plane: () => RELAY, link: () => null, fallBack }, 'the network changed')).toBe(false)
    expect(fallBack).not.toHaveBeenCalled()
  })
})
