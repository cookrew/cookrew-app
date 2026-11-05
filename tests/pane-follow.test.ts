import { describe, expect, it, vi } from 'vitest'
import { PaneFollower, type PaneFollowDeps } from '../src/main/pane-follow'

// BOX TEST 2, BUG 8. A Shell has no transcript, so its card knows only what a
// mirror told it, and a workspace switch or relaunch drops the mirror: the card
// froze at 494 with the true count at 513. A card on screen reads its pane.

function world(over: Partial<PaneFollowDeps> = {}) {
  const published: { id: string; text: string }[] = []
  const gone: string[] = []
  const deps: PaneFollowDeps = {
    candidates: () => ['a'],
    live: async () => new Set(['a']),
    capture: async () => '494',
    publish: (id, text) => void published.push({ id, text }),
    gone: (id) => void gone.push(id),
    ...over
  }
  return { follower: new PaneFollower(deps), published, gone }
}

describe('PaneFollower', () => {
  it('publishes what the pane shows', async () => {
    const w = world()
    await w.follower.tick()
    expect(w.published).toEqual([{ id: 'a', text: '494' }])
  })

  it('follows it as it moves, and stays quiet while it does not', async () => {
    let shown = '494'
    const w = world({ capture: async () => shown })
    await w.follower.tick()
    await w.follower.tick()
    expect(w.published).toHaveLength(1)
    shown = '513'
    await w.follower.tick()
    expect(w.published.at(-1)).toEqual({ id: 'a', text: '513' })
  })

  it('a pane with no process behind it is not read', async () => {
    const capture = vi.fn(async () => 'x')
    const w = world({ live: async () => new Set(), capture })
    await w.follower.tick()
    expect(capture).not.toHaveBeenCalled()
  })

  it('a followed pane that went away is reported once', async () => {
    let live = new Set(['a'])
    const w = world({ live: async () => live })
    await w.follower.tick()
    live = new Set()
    await w.follower.tick()
    await w.follower.tick()
    expect(w.gone).toEqual(['a'])
  })

  it('a pane that stopped being followed is not reported gone: its card got a mirror', async () => {
    let candidates = ['a']
    const w = world({ candidates: () => candidates })
    await w.follower.tick()
    candidates = []
    await w.follower.tick()
    expect(w.gone).toEqual([])
  })

  it('a failed listing proves nothing: blindness is not absence', async () => {
    let fail = false
    const w = world({
      live: async () => {
        if (fail) throw new Error('herdr down')
        return new Set(['a'])
      }
    })
    await w.follower.tick()
    fail = true
    await w.follower.tick()
    expect(w.gone).toEqual([])
  })

  it('a pane that cannot be read keeps what it last showed', async () => {
    let answer: string | null = '494'
    const w = world({ capture: async () => answer })
    await w.follower.tick()
    answer = null
    await w.follower.tick()
    expect(w.published).toHaveLength(1)
  })

  it('reads one pane failing as that pane failing', async () => {
    const w = world({
      candidates: () => ['a', 'b'],
      live: async () => new Set(['a', 'b']),
      capture: async (id) => {
        if (id === 'a') throw new Error('nope')
        return 'fine'
      }
    })
    await w.follower.tick()
    expect(w.published).toEqual([{ id: 'b', text: 'fine' }])
  })

  it('never stacks passes: a slow capture is not asked again', async () => {
    let release: (text: string) => void = () => undefined
    const capture = vi.fn(() => new Promise<string>((resolve) => (release = resolve)))
    const w = world({ capture })
    const first = w.follower.tick()
    await Promise.resolve()
    await Promise.resolve()
    await w.follower.tick()
    release('x')
    await first
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('reads a bounded number of panes per pass, taking turns', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `p${i}`)
    const seen: string[] = []
    const w = world({
      candidates: () => ids,
      live: async () => new Set(ids),
      capture: async (id) => {
        seen.push(id)
        return id
      },
      perPass: 2
    })
    await w.follower.tick()
    await w.follower.tick()
    await w.follower.tick()
    expect(seen).toEqual(['p0', 'p1', 'p2', 'p3', 'p4', 'p0'])
  })

  it('forget lets a returning pane publish again', async () => {
    const w = world()
    await w.follower.tick()
    w.follower.forget('a')
    await w.follower.tick()
    expect(w.published).toHaveLength(2)
  })
})
