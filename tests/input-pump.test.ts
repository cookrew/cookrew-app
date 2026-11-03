import { describe, expect, it } from 'vitest'
import { createInputPump } from '../src/renderer/src/input-pump'
import type { CastInputMsg } from '../src/renderer/src/browser-stream'

function harness() {
  const sent: CastInputMsg[] = []
  const frames: Array<() => void> = []
  const pump = createInputPump(
    (msg) => sent.push(msg),
    (callback) => frames.push(callback),
    (handle) => {
      frames[handle - 1] = () => undefined
    }
  )
  const tick = (): void => {
    const pending = frames.splice(0)
    for (const callback of pending) callback()
  }
  return { sent, pump, tick, frames }
}

describe('the input pump — one of each per frame', () => {
  it('moves: the newest wins, one per frame', () => {
    const { sent, pump, tick } = harness()
    pump.move({ t: 'move', x: 1, y: 1 })
    pump.move({ t: 'move', x: 2, y: 2 })
    pump.move({ t: 'move', x: 3, y: 3 })
    expect(sent).toEqual([])
    tick()
    expect(sent).toEqual([{ t: 'move', x: 3, y: 3 }])
  })
  it('wheels: deltas add up (no distance lost), the newest point wins', () => {
    const { sent, pump, tick } = harness()
    pump.wheel({ x: 1, y: 1 }, 2, 10, 0)
    pump.wheel({ x: 5, y: 5 }, 3, 15, 0)
    tick()
    expect(sent).toEqual([{ t: 'wheel', x: 5, y: 5, dy: 25, dx: 5 }])
  })
  it('a modifier change starts a new wheel instead of merging into the old one', () => {
    const { sent, pump, tick } = harness()
    pump.wheel({ x: 1, y: 1 }, 0, 10, 0)
    pump.wheel({ x: 1, y: 1 }, 0, 10, 8)
    expect(sent).toEqual([{ t: 'wheel', x: 1, y: 1, dy: 10 }])
    tick()
    expect(sent.at(-1)).toEqual({ t: 'wheel', x: 1, y: 1, dy: 10, mods: 8 })
  })
  it('pinch steps multiply; a net-zero pinch sends nothing', () => {
    const { sent, pump, tick } = harness()
    pump.pinch({ x: 1, y: 1 }, 1.1)
    pump.pinch({ x: 2, y: 2 }, 1.1)
    tick()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ t: 'pinch', x: 2, y: 2 })
    expect((sent[0] as { scale: number }).scale).toBeCloseTo(1.21)
    pump.pinch({ x: 1, y: 1 }, 2)
    pump.pinch({ x: 1, y: 1 }, 0.5)
    tick()
    expect(sent).toHaveLength(1)
  })
  it('flush sends what is pending NOW, in order — a click never overtakes its move', () => {
    const { sent, pump, frames } = harness()
    pump.move({ t: 'move', x: 9, y: 9 })
    pump.wheel({ x: 1, y: 1 }, 0, 4, 0)
    pump.flush()
    expect(sent.map((msg) => msg.t)).toEqual(['move', 'wheel'])
    // The frame it had asked for no longer sends anything twice.
    for (const callback of frames) callback()
    expect(sent).toHaveLength(2)
  })
  it('cancel drops what is pending (input just turned off)', () => {
    const { sent, pump, tick } = harness()
    pump.move({ t: 'move', x: 9, y: 9 })
    pump.cancel()
    tick()
    expect(sent).toEqual([])
  })
  it('retarget keeps the queue but sends through the new sender', () => {
    const { pump, tick } = harness()
    const other: CastInputMsg[] = []
    pump.move({ t: 'move', x: 1, y: 1 })
    pump.retarget((msg) => other.push(msg))
    tick()
    expect(other).toEqual([{ t: 'move', x: 1, y: 1 }])
  })
})
