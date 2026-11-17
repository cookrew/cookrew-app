import { describe, expect, it } from 'vitest'
import { createTileWake, type TileWakeDeps } from '../src/main/browser-tile-wake'

function harness(over: Partial<TileWakeDeps> = {}) {
  const log: string[] = []
  const held = new Set<string>()
  const live = new Set<string>()
  let clock = 100
  const deps: TileWakeDeps = {
    held: (id) => held.has(id),
    running: (id) => live.has(id),
    wakeable: () => true,
    start: async (id) => {
      log.push(`start ${id}`)
      live.add(id)
      return true
    },
    capture: async (id) => {
      log.push(`shot ${id}`)
      held.add(id)
    },
    usedSince: () => false,
    stop: async (id) => {
      log.push(`stop ${id}`)
      live.delete(id)
    },
    now: () => clock++,
    sleep: async () => undefined,
    shotsAtMs: [3000, 6000],
    ...over
  }
  return { wake: createTileWake(deps), log, held, live }
}

describe('waking a tile page that has no picture', () => {
  it('starts it, photographs it twice, and stops it', async () => {
    const { wake, log } = harness()
    wake.want(['a'])
    await wake.idle()
    expect(log).toEqual(['start a', 'shot a', 'shot a', 'stop a'])
  })

  it('one page at a time, in the order asked', async () => {
    const { wake, log } = harness()
    wake.want(['a', 'b'])
    await wake.idle()
    expect(log).toEqual(['start a', 'shot a', 'shot a', 'stop a', 'start b', 'shot b', 'shot b', 'stop b'])
  })

  it('never for a page with a picture, a running page, or one already tried this launch', async () => {
    const { wake, log, held, live } = harness()
    held.add('kept')
    live.add('open')
    wake.want(['kept', 'open', 'a'])
    await wake.idle()
    held.clear()
    wake.want(['a'])
    await wake.idle()
    expect(log.filter((line) => line.startsWith('start'))).toEqual(['start a'])
  })

  it('leaves running a page someone used meanwhile', async () => {
    const { wake, log } = harness({ usedSince: () => true })
    wake.want(['a'])
    await wake.idle()
    expect(log).toEqual(['start a', 'shot a', 'shot a'])
  })

  it("never starts a computer's screen or a card this Mac does not draw", async () => {
    const { wake, log } = harness({ wakeable: () => false })
    wake.want(['screen'])
    await wake.idle()
    expect(log).toEqual([])
  })

  it('a page that will not start is not photographed or stopped, and the queue goes on', async () => {
    const { wake, log } = harness({
      start: async (id) => {
        log.push(`start ${id}`)
        return id !== 'bad'
      }
    })
    wake.want(['bad', 'a'])
    await wake.idle()
    expect(log).toEqual(['start bad', 'start a', 'shot a', 'shot a', 'stop a'])
  })
})
