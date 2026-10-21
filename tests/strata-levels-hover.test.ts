import { describe, expect, it } from 'vitest'
import { createHoverIntent, type Timers } from '../src/strata/summary/hover-intent'
import { agentLabel, attachmentCounts, formatElapsed, modelLine, phaseLine, statusLine } from '../src/strata/summary/format'
import { classifyTouch, createWheelSwipe } from '../src/strata/input/gestures'

/** A manual clock: timers fire only when advanced. */
const clock = () => {
  let t = 0
  let seq = 0
  const queue = new Map<number, { at: number; fn: () => void }>()
  const timers: Timers = {
    set: (fn, ms) => {
      const id = ++seq
      queue.set(id, { at: t + ms, fn })
      return id
    },
    clear: (id) => void queue.delete(id as number),
    now: () => t
  }
  const advance = (ms: number) => {
    const end = t + ms
    for (;;) {
      const next = [...queue.entries()].filter(([, q]) => q.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      t = next[1].at
      queue.delete(next[0])
      next[1].fn()
    }
    t = end
  }
  return { timers, advance }
}

const setup = () => {
  const c = clock()
  const log: string[] = []
  const hover = createHoverIntent({ timers: c.timers, onShow: (k) => log.push(`show ${k}`), onHide: () => log.push('hide') })
  return { ...c, log, hover }
}

describe('hover intent', () => {
  it('shows after 120 ms of settling, not before', () => {
    const { hover, advance, log } = setup()
    hover.enter('a')
    advance(119)
    expect(log).toEqual([])
    advance(1)
    expect(log).toEqual(['show a'])
  })

  it('a pass-through shorter than the intent shows nothing', () => {
    const { hover, advance, log } = setup()
    hover.enter('a')
    advance(60)
    hover.leave('a')
    advance(500)
    expect(log).toEqual([])
  })

  it('once warm, a neighbour swaps in at once', () => {
    const { hover, advance, log } = setup()
    hover.enter('a')
    advance(120)
    hover.leave('a')
    hover.enter('b')
    expect(log).toEqual(['show a', 'show b'])
  })

  it('survives a short trip into the card, hides after the grace', () => {
    const { hover, advance, log } = setup()
    hover.enter('a')
    advance(120)
    hover.leave('a')
    advance(50)
    hover.holdCard()
    advance(500)
    expect(log).toEqual(['show a'])
    hover.releaseCard()
    advance(100)
    expect(log).toEqual(['show a', 'hide'])
  })

  it('stays warm for 400 ms after hiding', () => {
    const { hover, advance, log } = setup()
    hover.enter('a')
    advance(120)
    hover.leave('a')
    advance(100)
    advance(300)
    hover.enter('b')
    expect(log).toEqual(['show a', 'hide', 'show b'])
    hover.leave('b')
    advance(100 + 401)
    hover.enter('c')
    advance(119)
    expect(log).toEqual(['show a', 'hide', 'show b', 'hide'])
  })

  it('press-and-hold shows at once', () => {
    const { hover, log } = setup()
    hover.showNow('a')
    hover.hideNow()
    expect(log).toEqual(['show a', 'hide'])
  })
})

describe('summary wording', () => {
  const base = { phase: 'thinking' as const, phaseSince: 0, harness: 'claude' as const, model: null, status: null, task: null, reply: null }
  it('formats elapsed time', () => {
    expect(formatElapsed(34_000)).toBe('34s')
    expect(formatElapsed(252_000)).toBe('4m 12s')
    expect(formatElapsed(3 * 3600_000 + 5 * 60_000)).toBe('3h 5m')
    expect(formatElapsed(3 * 86400_000 + 2 * 3600_000)).toBe('3d 2h')
    expect(formatElapsed(null)).toBe('—')
  })
  it('never words a guess as fact', () => {
    expect(phaseLine({ ...base, phaseSource: 'live' }, 252_000)).toMatchObject({ label: 'thinking', source: 'live', live: true })
    expect(phaseLine({ ...base, phase: 'idle', phaseSource: 'probe' }, 1000)).toMatchObject({ label: 'probably idle', source: 'guess · multiplexer', live: false })
    expect(phaseLine({ ...base, phaseSource: 'ledger' }, 1000)).toMatchObject({ label: 'last turn', live: false })
    expect(phaseLine({ ...base, phaseSource: 'live' }, 1000, true)).toMatchObject({ source: 'last known · offline', live: false })
  })
  it('fills every line so the card height never changes', () => {
    expect(modelLine(base)).toBe('claude · harness default model')
    expect(statusLine({ status: null, phaseSource: 'live' }, false)).toBe('no live status')
    expect(statusLine({ status: 'Cerebrating… 34s', phaseSource: 'live' }, false)).toBe('Cerebrating… 34s')
  })
  it('counts attachments by kind and shared', () => {
    const counts = attachmentCounts({
      attachments: [
        { id: '1', kind: 'note', title: 'a', shared: true },
        { id: '2', kind: 'browser', title: 'b', shared: false },
        { id: '3', kind: 'note', title: 'c', shared: false }
      ]
    })
    expect(counts).toEqual({ notes: 2, browsers: 1, shared: 1 })
  })
  it('gives screen readers the same facts in one sentence', () => {
    const label = agentLabel({ ...base, id: 'a', name: 'Basil', orch: false, phaseSource: 'live', turns: 1, attachments: [], task: 'Ship it' }, 252_000)
    expect(label).toBe('Basil, claude · harness default model, thinking 4m 12s, live, task: Ship it')
  })
})

describe('swipes', () => {
  it('a trackpad swipe left goes in once per gesture, inertia included', () => {
    const swipe = createWheelSwipe()
    const out = [10, 30, 30, 30, 40, 40].map((dx, i) => swipe.feed({ deltaX: dx, deltaY: 1, at: i * 16 }).swipe)
    expect(out.filter(Boolean)).toEqual(['in'])
  })
  it('a new gesture after a quiet gap fires again; right goes out', () => {
    const swipe = createWheelSwipe()
    swipe.feed({ deltaX: 100, deltaY: 0, at: 0 })
    expect(swipe.feed({ deltaX: -100, deltaY: 0, at: 400 }).swipe).toBe('out')
  })
  it('vertical scrolling is not a swipe', () => {
    const swipe = createWheelSwipe()
    expect([0, 1, 2, 3].map((i) => swipe.feed({ deltaX: 30, deltaY: 60, at: i * 16 }).swipe).filter(Boolean)).toEqual([])
  })
  it('touch: left swipe goes in, a short slow drag does nothing, edges belong to the OS', () => {
    const base = { startY: 400, endY: 405, viewportWidth: 390 }
    expect(classifyTouch({ ...base, startX: 300, endX: 200, duration: 300 })).toBe('in')
    expect(classifyTouch({ ...base, startX: 100, endX: 200, duration: 300 })).toBe('out')
    expect(classifyTouch({ ...base, startX: 200, endX: 170, duration: 400 })).toBeNull()
    expect(classifyTouch({ ...base, startX: 200, endX: 170, duration: 50 })).toBe('in')
    expect(classifyTouch({ ...base, startX: 10, endX: 200, duration: 200 })).toBeNull()
    expect(classifyTouch({ startX: 200, endX: 260, startY: 100, endY: 300, duration: 200, viewportWidth: 390 })).toBeNull()
  })
})
