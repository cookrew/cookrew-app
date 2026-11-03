import { describe, expect, it, vi } from 'vitest'
import { routeCables, type CableLink, type CableRect } from '../src/renderer/src/cable-route'
import { TABS_PER_CARD, harnessView, tabLayout, tabPairKey, type ViewTab } from '../src/renderer/src/cable-view'
import {
  MAX_IN_FLIGHT,
  PULSE_FADE_MS,
  PULSE_MIN_MS,
  PULSE_SCREEN_PX,
  PULSE_SPEED_PX_S,
  SIGNAL_TTL_MS,
  admit,
  pathLength,
  pulseDuration,
  pulseKeyframes,
  createSignalFeed,
  expire,
  linkBetween,
  litLinks,
  nextExpiry,
  pathD,
  signalPath,
  tabSignal,
  trunkSignal,
  type LiveSignal
} from '../src/renderer/src/cable-signal'
import { CableSignalBus } from '../src/main/cable-signal'
import { browserVerbKind, isCableSignal, noteVerbKind, type CableSignal } from '../src/shared/cable-signal'

/**
 * SIGNALS ON THE CABLES, AS ARITHMETIC.
 *
 * When agent A asks agent B the cable between them carries a pulse from A to
 * B; when B answers, from B to A. Everything that decides what lights, for
 * how long, along which polyline and in which direction is pure and is
 * checked here without a DOM — the component sets what these return.
 */

const NOW = 1_790_000_000_000
const sig = (from: string, to: string, kind: CableSignal['kind'] = 'ask', at = NOW): CableSignal => ({ from, to, kind, at })
const card = (id: string, x: number, y: number, width = 640, height = 420): CableRect => ({ id, x, y, width, height })
const link = (a: string, b: string): CableLink => ({ id: `${a}~${b}`, a, b })
const ALL = { farPx: Number.POSITIVE_INFINITY }

describe('what a signal is', () => {
  it('is a sender, a receiver, a kind and a stamp — and nothing else is one', () => {
    expect(isCableSignal(sig('a', 'b'))).toBe(true)
    expect(isCableSignal(sig('a', 'b', 'answer'))).toBe(true)
    expect(isCableSignal({ ...sig('a', 'b'), kind: 'token' })).toBe(false)
    expect(isCableSignal({ ...sig('a', 'b'), at: 'now' })).toBe(false)
    expect(isCableSignal(sig('', 'b'))).toBe(false)
    expect(isCableSignal(null)).toBe(false)
  })

  it('refuses a card asking itself', () => {
    // There is no cable from a card to itself; a self-signal would light nothing and log.
    expect(isCableSignal(sig('a', 'a'))).toBe(false)
  })
})

describe('the bus in main', () => {
  it('stamps the moment and hands every listener the same frame', () => {
    const bus = new CableSignalBus(() => NOW)
    const seen: CableSignal[] = []
    bus.on((s) => seen.push(s))
    bus.on((s) => seen.push(s))
    expect(bus.emit({ from: 'orch', to: 'forge', kind: 'ask' })).toBe(true)
    expect(seen).toEqual([sig('orch', 'forge'), sig('orch', 'forge')])
  })

  it('drops a malformed moment rather than lighting nothing', () => {
    const bus = new CableSignalBus(() => NOW)
    const seen: CableSignal[] = []
    bus.on((s) => seen.push(s))
    expect(bus.emit({ from: 'orch', to: 'orch', kind: 'ask' })).toBe(false)
    expect(bus.emit({ from: '', to: 'forge', kind: 'ask' })).toBe(false)
    expect(seen).toEqual([])
  })

  it('is fire-and-forget: a throwing listener reaches neither the producer nor the next listener', () => {
    const bus = new CableSignalBus(() => NOW)
    const seen: string[] = []
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    bus.on(() => {
      throw new Error('bridge gone')
    })
    bus.on((s) => seen.push(s.to))
    expect(() => bus.emit({ from: 'a', to: 'b', kind: 'answer' })).not.toThrow()
    expect(seen).toEqual(['b'])
    quiet.mockRestore()
  })

  it('lets a listener leave', () => {
    const bus = new CableSignalBus(() => NOW)
    const off = bus.on(() => undefined)
    expect(bus.size).toBe(1)
    off()
    expect(bus.size).toBe(0)
  })
})

describe('what is in flight', () => {
  it('lives for its kind’s lifetime, counted from the stamp', () => {
    const list = admit([], sig('a', 'b', 'ask'), NOW)
    expect(list).toHaveLength(1)
    expect(list[0].until).toBe(NOW + SIGNAL_TTL_MS.ask)
    expect(expire(list, NOW + SIGNAL_TTL_MS.ask - 1)).toBe(list) // same reference: nothing changed
    expect(expire(list, NOW + SIGNAL_TTL_MS.ask)).toEqual([])
  })

  it('gives the answer a little longer than the ask — it is the one people wait for', () => {
    expect(SIGNAL_TTL_MS.answer).toBeGreaterThan(SIGNAL_TTL_MS.ask)
  })

  it('refuses a signal already older than its lifetime on arrival', () => {
    // A phone waking up can deliver a batch at once; old traffic lit as new is a lie.
    const late = sig('a', 'b', 'ask', NOW - SIGNAL_TTL_MS.ask)
    expect(admit([], late, NOW)).toEqual([])
  })

  it('refreshes a repeat of the same moment instead of doubling the pulse', () => {
    const first = admit([], sig('a', 'b', 'ask', NOW), NOW)
    const again = admit(first, sig('a', 'b', 'ask', NOW + 500), NOW + 500)
    expect(again).toHaveLength(1)
    expect(again[0].until).toBe(NOW + 500 + SIGNAL_TTL_MS.ask)
  })

  it('keeps an ask and its answer apart — they travel opposite ways', () => {
    const list = admit(admit([], sig('a', 'b', 'ask'), NOW), sig('b', 'a', 'answer', NOW + 10), NOW + 10)
    expect(list.map((s) => s.kind)).toEqual(['ask', 'answer'])
  })

  it('caps what is in flight and drops the oldest', () => {
    let list: LiveSignal[] = []
    for (let i = 0; i < MAX_IN_FLIGHT + 2; i += 1) {
      list = admit(list, sig(`c${i}`, 'hub', 'ask', NOW + i), NOW + i)
    }
    expect(list).toHaveLength(MAX_IN_FLIGHT)
    expect(list[0].from).toBe('c2')
  })

  it('sweeps the dead while admitting, so a dead one never counts against the cap', () => {
    const old = admit([], sig('x', 'y', 'ask', NOW), NOW)
    const later = admit(old, sig('a', 'b', 'ask', NOW + 10_000), NOW + 10_000)
    expect(later.map((s) => s.from)).toEqual(['a'])
  })

  it('knows when the next one runs out, and that nothing runs out of an empty list', () => {
    expect(nextExpiry([])).toBeNull()
    const list = admit(admit([], sig('a', 'b', 'answer'), NOW), sig('c', 'd', 'ask', NOW + 100), NOW + 100)
    expect(nextExpiry(list)).toBe(NOW + 100 + SIGNAL_TTL_MS.ask)
  })
})

describe('which cable, which way', () => {
  const links = [link('orch', 'forge'), link('fresco', 'orch')]

  it('finds the cable by the pair, whichever way round it was drawn', () => {
    expect(linkBetween(links, 'orch', 'forge')?.id).toBe('orch~forge')
    expect(linkBetween(links, 'forge', 'orch')?.id).toBe('orch~forge')
    expect(linkBetween(links, 'orch', 'fresco')?.id).toBe('fresco~orch')
    expect(linkBetween(links, 'orch', 'nobody')).toBeNull()
  })

  it('lights a link by its newest signal', () => {
    const list = admit(admit([], sig('orch', 'forge', 'ask', NOW), NOW), sig('forge', 'orch', 'answer', NOW + 10), NOW + 10)
    const lit = litLinks(list, links)
    expect(lit.get('orch~forge')).toEqual({ kind: 'answer', from: 'forge', to: 'orch' })
    expect(lit.has('fresco~orch')).toBe(false)
  })

  it('lights a trunk that carries a lit link, and leaves the rest dark', () => {
    const lit = litLinks(admit([], sig('orch', 'forge'), NOW), links)
    expect(trunkSignal({ links: ['fresco~orch', 'orch~forge'] }, lit)).toBe('ask')
    expect(trunkSignal({ links: ['fresco~orch'] }, lit)).toBeNull()
  })

  it('lights the tab naming the partner when the cable itself is not drawn', () => {
    const lit = litLinks(admit([], sig('forge', 'orch', 'answer'), NOW), links)
    expect(tabSignal(lit, links, 'orch', 'forge')).toBe('answer')
    expect(tabSignal(lit, links, 'forge', 'orch')).toBe('answer')
    expect(tabSignal(lit, links, 'orch', 'fresco')).toBeNull()
  })
})

describe('the polyline the pulse follows', () => {
  const rects = [card('a', 0, 0), card('b', 2000, 0)]
  const links = [link('a', 'b')]
  const harness = routeCables(rects, links, ALL)

  it('runs from the sender’s edge to the receiver’s edge through the trunk', () => {
    const path = signalPath(harness, 'a~b', 'a')!
    expect(path).not.toBeNull()
    // Starts on a's right edge, ends on b's left edge.
    expect(path[0].x).toBe(640)
    expect(path[path.length - 1].x).toBe(2000)
    // Every trunk the link rides is in the walk.
    const rode = harness.trunks.filter((t) => t.links.includes('a~b')).length
    expect(path.length).toBe(2 + rode + 1)
  })

  it('runs the other way for the answer', () => {
    const ask = signalPath(harness, 'a~b', 'a')!
    const answer = signalPath(harness, 'a~b', 'b')!
    expect(answer[0]).toEqual(ask[ask.length - 1])
    expect(answer[answer.length - 1]).toEqual(ask[0])
  })

  it('follows a shared trunk and leaves it where the cables part', () => {
    // Two cards stacked on the left wired to one hub: their runs share the
    // corridor (the router's own bundling fixture), and each pulse must ride
    // the shared trunk and still end at its own card.
    const three = [card('a', 0, 0), card('b', 0, 600), card('hub', 2400, 300)]
    const shared = routeCables(three, [link('a', 'hub'), link('b', 'hub')], { farPx: 4000 })
    expect(shared.trunks.some((t) => t.count === 2)).toBe(true)
    const fromA = signalPath(shared, 'a~hub', 'a')!
    const fromB = signalPath(shared, 'b~hub', 'b')!
    expect(fromA).not.toBeNull()
    expect(fromB).not.toBeNull()
    expect(fromA[0].y).toBeLessThan(fromB[0].y)
    expect(fromA[fromA.length - 1].x).toBe(2400)
    expect(fromB[fromB.length - 1].x).toBe(2400)
    // The answer back to `a` retraces the same points.
    const back = signalPath(shared, 'a~hub', 'hub')!
    expect(back).toEqual([...fromA].reverse())
  })

  it('is null for a cable the router did not draw — never a partial path', () => {
    // A far cable has no stubs: it is a tab, not a run.
    const far = routeCables(rects, links, { farPx: 100 })
    expect(signalPath(far, 'a~b', 'a')).toBeNull()
    // And a chain with a trunk missing cannot be closed.
    const broken = { stubs: harness.stubs, trunks: harness.trunks.filter((t) => !t.links.includes('a~b')) }
    expect(signalPath(broken, 'a~b', 'a')).toBeNull()
    expect(signalPath(harness, 'nope', 'a')).toBeNull()
  })

  it('spells the polyline as a path the compositor can follow', () => {
    expect(pathD([{ x: 1.004, y: 2 }, { x: 30, y: 2 }, { x: 30, y: 44.5 }])).toBe('M 1 2 L 30 2 L 30 44.5')
  })

  it('lights only the drawn half of the harness: a lit link with one end off stage is a lamp', () => {
    const wide = { x: -500, y: -500, width: 6000, height: 3600 }
    const narrow = { x: -500, y: -500, width: 2000, height: 1200 }
    const lit = litLinks(admit([], sig('a', 'b'), NOW), links)
    const drawn = harnessView(harness, rects, links, wide, null)
    expect(drawn.drawn.has('a~b')).toBe(true)
    expect(drawn.trunks.some((t) => trunkSignal(t, lit) === 'ask')).toBe(true)
    const tabbed = harnessView(harness, rects, links, narrow, null)
    expect(tabbed.drawn.has('a~b')).toBe(false)
    expect(tabbed.tabs.map((t) => tabSignal(lit, links, t.card, t.partner))).toEqual(['ask'])
  })
})

describe('the feed', () => {
  interface Clock {
    now: () => number
    tick: (ms: number) => void
    pending: () => number
    schedule: (fn: () => void, ms: number) => () => void
  }
  function clock(start = NOW): Clock {
    let t = start
    const timers: { at: number; fn: () => void }[] = []
    return {
      now: () => t,
      tick: (ms) => {
        t += ms
        for (const timer of [...timers].sort((a, b) => a.at - b.at)) {
          if (timer.at > t) continue
          timers.splice(timers.indexOf(timer), 1)
          timer.fn()
        }
      },
      pending: () => timers.length,
      schedule: (fn, ms) => {
        const timer = { at: t + ms, fn }
        timers.push(timer)
        return () => {
          const i = timers.indexOf(timer)
          if (i >= 0) timers.splice(i, 1)
        }
      }
    }
  }

  it('arms one timer for the nearest expiry and none when nothing is in flight', () => {
    const c = clock()
    const feed = createSignalFeed(c.now, c.schedule)
    expect(c.pending()).toBe(0)
    feed.push(sig('a', 'b', 'ask'))
    feed.push(sig('c', 'd', 'answer'))
    expect(c.pending()).toBe(1)
    expect(feed.snapshot()).toHaveLength(2)
    c.tick(SIGNAL_TTL_MS.ask)
    expect(feed.snapshot().map((s) => s.kind)).toEqual(['answer'])
    expect(c.pending()).toBe(1)
    c.tick(SIGNAL_TTL_MS.answer)
    expect(feed.snapshot()).toEqual([])
    expect(c.pending()).toBe(0)
  })

  it('hands subscribers the same reference until something changes', () => {
    const c = clock()
    const feed = createSignalFeed(c.now, c.schedule)
    let notified = 0
    feed.subscribe(() => (notified += 1))
    const before = feed.snapshot()
    expect(feed.snapshot()).toBe(before)
    feed.push(sig('a', 'b'))
    expect(notified).toBe(1)
    const after = feed.snapshot()
    expect(after).not.toBe(before)
    c.tick(100)
    expect(feed.snapshot()).toBe(after) // the sweep only runs at expiry
    expect(notified).toBe(1)
  })

  it('ignores frames that are not signals', () => {
    const c = clock()
    const feed = createSignalFeed(c.now, c.schedule)
    feed.push({ hello: 'world' })
    feed.push('ask')
    expect(feed.snapshot()).toEqual([])
    expect(c.pending()).toBe(0)
  })

  it('resets to nothing, disarmed', () => {
    const c = clock()
    const feed = createSignalFeed(c.now, c.schedule)
    feed.push(sig('a', 'b'))
    feed.reset()
    expect(feed.snapshot()).toEqual([])
    expect(c.pending()).toBe(0)
  })
})

describe('round two: four kinds, and the direction is the pair', () => {
  it('admits a write and a read as signals', () => {
    expect(isCableSignal(sig('orch', 'spec', 'write'))).toBe(true)
    expect(isCableSignal(sig('spec', 'orch', 'read'))).toBe(true)
    expect(isCableSignal({ ...sig('a', 'b'), kind: 'drive' })).toBe(false)
  })

  it('maps every note verb: write and edit go in, read comes out, create and delete light nothing', () => {
    expect(noteVerbKind('write')).toBe('write')
    expect(noteVerbKind('edit')).toBe('write')
    expect(noteVerbKind('read')).toBe('read')
    expect(noteVerbKind('create')).toBeNull()
    expect(noteVerbKind('delete')).toBeNull()
  })

  it('maps every browser verb: driving the page goes in, taking its words or picture comes out', () => {
    for (const v of ['navigate', 'click', 'fill', 'type', 'key', 'scroll', 'evaluate']) expect(browserVerbKind(v), v).toBe('write')
    for (const v of ['text', 'html', 'snapshot', 'info']) expect(browserVerbKind(v), v).toBe('read')
    expect(browserVerbKind('create')).toBeNull()
    expect(browserVerbKind('tab-new')).toBeNull()
  })

  it('keeps a glance shorter than a question', () => {
    expect(SIGNAL_TTL_MS.write).toBeLessThan(SIGNAL_TTL_MS.ask)
    expect(SIGNAL_TTL_MS.read).toBeLessThan(SIGNAL_TTL_MS.ask)
  })
})

describe('round two: the pulse is a screen-sized thing at one speed', () => {
  const short = [{ x: 0, y: 0 }, { x: 300, y: 0 }]
  const long = [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 4000 }]

  it('measures the polyline', () => {
    expect(pathLength(short)).toBe(300)
    expect(pathLength(long)).toBe(8000)
    expect(pathLength([])).toBe(0)
  })

  it('takes longer on a long cable than a short one, at the same zoom', () => {
    expect(pulseDuration(long, 1, 'ask')).toBeGreaterThan(pulseDuration(short, 1, 'ask'))
  })

  it('is a speed in SCREEN pixels: the same cable is quicker zoomed out', () => {
    const near = pulseDuration(long, 1, 'ask')
    const far = pulseDuration(long, 0.1, 'ask')
    expect(far).toBeLessThan(near)
    // 8000 flow px at zoom 0.1 is 800 screen px: 800 / 600 px/s.
    expect(far).toBe(Math.round((800 / PULSE_SPEED_PX_S) * 1000))
  })

  it('is never shorter than a glance nor longer than the lit trunks', () => {
    expect(pulseDuration([{ x: 0, y: 0 }, { x: 10, y: 0 }], 1, 'ask')).toBe(PULSE_MIN_MS)
    expect(pulseDuration(long, 4, 'ask')).toBe(SIGNAL_TTL_MS.ask - PULSE_FADE_MS)
    expect(pulseDuration(long, 4, 'write')).toBe(SIGNAL_TTL_MS.write - PULSE_FADE_MS)
  })

  it('has a diameter on screen that does not depend on the zoom', () => {
    // CableHarness divides by the zoom; the constant is the whole contract.
    expect(PULSE_SCREEN_PX).toBeGreaterThanOrEqual(10)
  })

  it('places the keyframes by distance, so the dot moves at one speed round every corner', () => {
    const frames = pulseKeyframes(long, 2000)
    expect(frames[0]).toMatchObject({ transform: 'translate(0px, 0px)', offset: 0, opacity: 0 })
    expect(frames[frames.length - 1]).toMatchObject({ transform: 'translate(4000px, 4000px)', offset: 1, opacity: 0 })
    const corner = frames.find((f) => f.transform === 'translate(4000px, 0px)')!
    expect(corner.offset).toBe(0.5) // half the length, half the time
    for (let i = 1; i < frames.length; i += 1) expect(frames[i].offset).toBeGreaterThan(frames[i - 1].offset)
  })

  it('is lit for the trip and fades at the end, inside the trip', () => {
    const frames = pulseKeyframes(long, 2000)
    const lit = frames.filter((f) => f.opacity === 1)
    expect(lit.length).toBeGreaterThanOrEqual(2)
    expect(lit[0].offset).toBeLessThanOrEqual(0.08)
    expect(lit[lit.length - 1].offset).toBeGreaterThanOrEqual(1 - PULSE_FADE_MS / 2000 - 0.01)
  })

  it('does not divide by zero on a path with no length', () => {
    expect(() => pulseKeyframes([{ x: 1, y: 1 }], 500)).not.toThrow()
    expect(pulseKeyframes([], 500)).toEqual([])
  })
})

describe('round two: the lamp on a hub', () => {
  const hub = card('hub', 0, 0)
  const partners = Array.from({ length: 10 }, (_, i) => card(`p${i}`, 3000, i * 500))
  const rects = new Map([hub, ...partners].map((r) => [r.id, r]))
  const names = new Map(partners.map((p) => [p.id, p.id.toUpperCase()]))
  const order = new Map([hub, ...partners].map((r, i) => [r.id, i]))
  const tabs: ViewTab[] = partners.map((p) => ({ card: 'hub', partner: p.id, hot: false }))

  it('folds an old partner behind +N when nothing is lit', () => {
    const laid = tabLayout(tabs, rects, names, order, new Set())
    expect(laid.filter((t) => !t.more)).toHaveLength(TABS_PER_CARD - 1)
    expect(laid.some((t) => t.partner === 'p0')).toBe(false) // the oldest is hidden
    expect(laid.find((t) => t.more)?.lit).toBe(false)
  })

  it('promotes the lit partner out of the fold for the signal’s lifetime', () => {
    const lit = new Set([tabPairKey('hub', 'p0')])
    const laid = tabLayout(tabs, rects, names, order, new Set(), TABS_PER_CARD, lit)
    const shown = laid.filter((t) => !t.more)
    expect(shown[0].partner).toBe('p0')
    expect(shown[0].lit).toBe(true)
    expect(shown).toHaveLength(TABS_PER_CARD - 1)
    expect(laid.find((t) => t.more)?.lit).toBe(false)
  })

  it('lights the fold itself only when more partners are lit than fit', () => {
    const lit = new Set(Array.from({ length: 8 }, (_, i) => tabPairKey('hub', `p${i}`)))
    const laid = tabLayout(tabs, rects, names, order, new Set(), TABS_PER_CARD, lit)
    expect(laid.find((t) => t.more)?.lit).toBe(true)
  })

  it('reads the pair the way the tab names it', () => {
    expect(tabPairKey('a', 'b')).not.toBe(tabPairKey('b', 'a'))
  })
})
