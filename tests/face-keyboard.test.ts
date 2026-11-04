// THE FACE AND THE KEYBOARD (owner, 2026-11-04: the motion was all but cut off
// by the keyboard). A phone reports its keyboard only once it has landed, so a
// flight run at the foot of the screen plays behind it. The cover is expected
// instead: published at the focus from the last one seen, corrected by the real
// one, dropped if none comes. Rules here, stand-in elements for the animations;
// the frames are checked headless against a simulated keyboard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KEYBOARD_GONE_MS, coverGuess, inGesture, keyboardWatch, shownCover, takesKeys, NO_KEYBOARD_MS, SETTLE_MS, type KeyboardEnv } from '../src/renderer/src/keyboard-expect'
import { flipFrom, flyFace, riseBox, RISE_MS, type Box } from '../src/renderer/src/prompt/face-flip'
import { FOLD_MS, KEYBOARD_HOLD_MS, flyBack, shutInsets, type FoldSnapshot } from '../src/renderer/src/prompt/fold-flight'
import { glideBox } from '../src/renderer/src/keyboard-expect'

type Frame = Record<string, string | number | null | undefined>
interface Call {
  readonly frames: Frame[]
  readonly options: KeyframeAnimationOptions
}
type Fake = HTMLElement & { calls: Call[] }

const fake = (rect: Box): Fake => {
  const calls: Call[] = []
  return {
    calls,
    getBoundingClientRect: () => rect,
    animate: (frames: Frame[], options: KeyframeAnimationOptions) => {
      calls.push({ frames, options })
      return { finished: new Promise(() => undefined), cancel: () => undefined }
    },
    remove: () => undefined
  } as unknown as Fake
}

const setReduced = (reduced: boolean): void => {
  ;(globalThis as unknown as { window: unknown }).window = {
    matchMedia: (q: string) => ({ matches: reduced && q === '(prefers-reduced-motion: reduce)' })
  }
}

function env(over: Partial<KeyboardEnv> = {}): KeyboardEnv & { shown: number[]; glides: number[]; kept: (number | null)[]; bands: number[] } {
  const shown: number[] = []
  const bands: number[] = []
  const glides: number[] = []
  const kept: (number | null)[] = []
  return {
    shown,
    glides,
    kept,
    bands,
    band: (px) => void bands.push(px),
    publish: (cover, glideFrom) => {
      shown.push(cover)
      if (glideFrom !== null) glides.push(glideFrom)
    },
    recall: () => 300,
    remember: (cover) => void kept.push(cover),
    viewHeight: () => 780,
    touch: () => true,
    ...over
  }
}

describe('the cover to expect', () => {
  it('is the last one seen, or 40% of the screen the first time', () => {
    expect(coverGuess(320, 800)).toBe(320)
    expect(coverGuess(null, 800)).toBe(320)
    expect(coverGuess(null, 781)).toBe(312)
  })
  it('is nothing where no keyboard came last time', () => {
    expect(coverGuess(0, 800)).toBe(0)
  })
  it('what shows is never less than expected until it settles', () => {
    expect(shownCover(40, 300)).toBe(300)
    expect(shownCover(320, 300)).toBe(320)
    expect(shownCover(280, null)).toBe(280)
  })
})

describe('what can raise a keyboard', () => {
  it('a gesture: a focus coming back with the app raises none', () => {
    expect(inGesture({ userActivation: { isActive: true } })).toBe(true)
    expect(inGesture({ userActivation: { isActive: false } })).toBe(false)
  })
  it('an engine that cannot say is taken at its word', () => {
    expect(inGesture({})).toBe(true)
  })
  it('a field that takes keys, whoever has the focus next', () => {
    const el = (hit: boolean) => ({ matches: () => hit }) as unknown as Element
    expect(takesKeys(el(true))).toBe(true)
    expect(takesKeys(el(false))).toBe(false)
    expect(takesKeys(null)).toBe(false)
  })
})

describe('the band behind the keyboard', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('waits for a real keyboard: an expected one lays no band over the box rising through it', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(0)
    w.expect()
    expect(e.bands).toEqual([0])
    // A browser may report it as it starts: the box is still rising.
    w.report(300)
    expect(e.bands).toEqual([0])
    vi.advanceTimersByTime(SETTLE_MS)
    expect(e.bands).toEqual([0, 300])
  })
  it('a keyboard nobody expected lays it at once', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(0)
    w.report(300)
    expect(e.bands).toEqual([0, 300])
  })
  it('goes as soon as the keyboard starts leaving, before the page hears it has left', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(300)
    w.leaving()
    expect(e.bands.at(-1)).toBe(0)
    // The cover itself stands until the viewport says so.
    expect(e.shown.at(-1)).toBe(300)
    w.report(0)
    expect(e.shown.at(-1)).toBe(0)
  })
  it('comes back by itself if the keyboard stayed (the focus went to a terminal, say)', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(300)
    w.leaving()
    expect(e.bands.at(-1)).toBe(0)
    vi.advanceTimersByTime(KEYBOARD_GONE_MS)
    expect(e.bands.at(-1)).toBe(300)
  })
  it('a leaving with no keyboard up leaves nothing behind for the next one', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(0)
    w.leaving()
    w.report(300)
    expect(e.bands.at(-1)).toBe(300)
  })
  it('comes back if the focus only moved to another field', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(300)
    w.leaving()
    w.expect()
    expect(e.bands.at(-1)).toBe(300)
  })
})

describe('the keyboard watch', () => {
  beforeEach(() => void vi.useFakeTimers())
  afterEach(() => void vi.useRealTimers())

  it('publishes the expected cover at once, and says how far the box rises', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(0)
    expect(w.expect()).toBe(300)
    expect(e.shown).toEqual([0, 300])
  })
  it('expects nothing on a screen with no touch, or with the keyboard already up, or twice', () => {
    expect(keyboardWatch(env({ touch: () => false })).expect()).toBe(0)
    const up = keyboardWatch(env())
    up.report(300)
    expect(up.expect()).toBe(0)
    const twice = keyboardWatch(env())
    twice.report(0)
    twice.expect()
    expect(twice.expect()).toBe(0)
  })
  it('the real keyboard takes over: a small difference glides, and is remembered once settled', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(0)
    w.expect()
    w.report(280)
    expect(e.shown.at(-1)).toBe(300)
    vi.advanceTimersByTime(SETTLE_MS)
    expect(e.shown.at(-1)).toBe(280)
    expect(e.glides).toEqual([300])
    expect(e.kept).toEqual([280])
  })
  it('a keyboard reporting its way up never pulls the box down', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(0)
    w.expect()
    w.report(40)
    w.report(180)
    expect(e.shown).toEqual([0, 300])
    w.report(300)
    vi.advanceTimersByTime(SETTLE_MS)
    expect(e.shown).toEqual([0, 300])
    expect(e.kept).toEqual([300])
  })
  it('no keyboard comes (a hardware one): the box glides back and the next focus expects none', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(0)
    w.expect()
    vi.advanceTimersByTime(NO_KEYBOARD_MS)
    expect(e.shown.at(-1)).toBe(0)
    expect(e.glides).toEqual([300])
    expect(e.kept).toEqual([0])
  })
  it('a keyboard seen later is learned again', () => {
    const e = env({ recall: () => 0 })
    const w = keyboardWatch(e)
    w.report(0)
    expect(w.expect()).toBe(0)
    w.report(310)
    vi.advanceTimersByTime(SETTLE_MS)
    expect(e.kept).toEqual([310])
  })
  it('the field let go before the keyboard came: the expectation is dropped, nothing learned', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(0)
    w.expect()
    w.leaving()
    expect(e.shown.at(-1)).toBe(0)
    vi.advanceTimersByTime(NO_KEYBOARD_MS)
    expect(e.kept).toEqual([])
  })
  it('a fraction of a pixel at rest is no keyboard, and a real cover is whole', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(0.4)
    expect(e.shown).toEqual([0])
    expect(w.expect()).toBe(300)
    w.report(299.6)
    vi.advanceTimersByTime(SETTLE_MS)
    expect(e.kept).toEqual([300])
  })
  it('a keyboard taller than expected glides up to it', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(0)
    w.expect()
    w.report(340)
    expect(e.shown.at(-1)).toBe(340)
    expect(e.glides).toEqual([300])
  })
  it('a plain keyboard, nothing expected, is published as it reports, unglided, once per change', () => {
    const e = env()
    const w = keyboardWatch(e)
    w.report(0)
    w.report(0)
    w.report(300)
    w.report(0)
    expect(e.shown).toEqual([0, 300, 0])
    expect(e.glides).toEqual([])
  })
})

// A 360 phone: the folded face at the bar's end, the chip above the keyboard.
const FOLDED: Box = { left: 312, top: 733, width: 34, height: 34 }
const CHIP: Box = { left: 22, top: 436, width: 24, height: 24 }
const BOX: Box = { left: 8, top: 424, width: 344, height: 48 }
const COVER = 300

describe('a correction of the cover', () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })
  it('glides the box alone: a transform on the dock would carry the fixed box being shut along with it', () => {
    setReduced(false)
    const box = fake(BOX)
    glideBox(box, -20)
    expect(box.calls[0].frames[0].transform).toBe('translateY(-20px)')
  })
  it('a pixel is not worth a glide, and reduced motion takes none', () => {
    setReduced(false)
    const box = fake(BOX)
    glideBox(box, 1)
    expect(box.calls).toHaveLength(0)
    setReduced(true)
    glideBox(box, -20)
    expect(box.calls).toHaveLength(0)
  })
})

describe('the open rises with the keyboard', () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })
  it('the box rises from the foot, faster than a keyboard', () => {
    setReduced(false)
    const box = fake(BOX)
    riseBox(box, COVER)
    expect(box.calls[0].frames[0].transform).toBe(`translateY(${COVER}px)`)
    expect(box.calls[0].frames.at(-1)!.transform).toBe('none')
    expect(RISE_MS).toBeLessThan(250)
  })
  it('with a menu open nothing moves on a transform: it would carry the menu, fixed, along with it', () => {
    setReduced(false)
    const box = Object.assign(fake(BOX), { querySelector: () => ({}) })
    riseBox(box, COVER)
    glideBox(box, -20)
    expect(box.calls).toHaveLength(0)
  })
  it('nothing rises for no cover, or under reduced motion', () => {
    setReduced(false)
    const box = fake(BOX)
    riseBox(box, 0)
    expect(box.calls).toHaveLength(0)
    setReduced(true)
    riseBox(box, COVER)
    expect(box.calls).toHaveLength(0)
  })
  it('the face rides inside the rising box: its own flight takes the rise out, so it starts on the bar', () => {
    setReduced(false)
    const face = fake(CHIP)
    const box = fake(BOX)
    flyFace(face, FOLDED, { box, rest: [], rise: COVER })
    const move = flipFrom(FOLDED, CHIP)!
    expect(face.calls[0].frames[0].transform).toBe(`translate(${move.dx}px, ${move.dy - COVER}px) scale(${move.s})`)
    expect(box.calls.some((c) => c.frames[0].transform === `translateY(${COVER}px)`)).toBe(true)
  })
  it('a chip measured while the box rises still starts the face on the bar', () => {
    setReduced(false)
    // As a browser does: an animation running on the box moves the chip's rect.
    let shift = 0
    const box = fake(BOX)
    const animate = box.animate.bind(box)
    box.animate = ((frames: Frame[], options: KeyframeAnimationOptions) => {
      if (frames[0].transform) shift = COVER
      return animate(frames as unknown as Keyframe[], options)
    }) as unknown as typeof box.animate
    const face = Object.assign(fake(CHIP), { getBoundingClientRect: () => ({ ...CHIP, top: CHIP.top + shift }) })
    flyFace(face, FOLDED, { box, rest: [], rise: COVER })
    const move = flipFrom(FOLDED, CHIP)!
    expect(face.calls[0].frames[0].transform).toBe(`translate(${move.dx}px, ${move.dy - COVER}px) scale(${move.s})`)
  })
  it('with no keyboard coming the flight is what it was', () => {
    setReduced(false)
    const face = fake(CHIP)
    const box = fake(BOX)
    flyFace(face, FOLDED, { box, rest: [] })
    const move = flipFrom(FOLDED, CHIP)!
    expect(face.calls[0].frames[0].transform).toBe(`translate(${move.dx}px, ${move.dy}px) scale(${move.s})`)
    expect(box.calls.every((c) => c.frames[0].transform === undefined)).toBe(true)
  })
})

describe('the fold follows the keyboard down', () => {
  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window
  })
  const snap = (ghost: Fake): FoldSnapshot => ({ box: BOX, face: CHIP, display: 'flex', clip: 'none', ghost })

  it('the face waits for the keyboard to start clearing its way', () => {
    setReduced(false)
    const face = fake(FOLDED)
    flyBack(face, snap(fake(BOX)), { dot: null, bar: null, page: null, cover: COVER })
    expect(face.calls[0].options.delay).toBe(KEYBOARD_HOLD_MS)
    expect(face.calls[0].options.fill).toBe('backwards')
    expect(face.calls[0].options.duration).toBe(FOLD_MS)
  })
  it('the box sinks with it, and shuts onto the face where the keyboard was', () => {
    setReduced(false)
    const ghost = fake(BOX)
    flyBack(fake(FOLDED), snap(ghost), { dot: null, bar: null, page: null, cover: COVER })
    const [shut] = ghost.calls
    const i = shutInsets(FOLDED, { ...BOX, top: BOX.top + COVER })
    expect(shut.options.delay).toBe(KEYBOARD_HOLD_MS)
    expect(shut.frames[0].transform).toBe('none')
    expect(shut.frames.at(-1)!.transform).toBe(`translateY(${COVER}px)`)
    expect(String(shut.frames.at(-1)!.clipPath)).toContain(`inset(${i.top}px ${i.right}px ${i.bottom}px ${i.left}px `)
  })
  it('the draft dot still lands after the face', () => {
    setReduced(false)
    const dot = fake({ left: 0, top: 0, width: 9, height: 9 })
    flyBack(fake(FOLDED), snap(fake(BOX)), { dot, bar: null, page: null, cover: COVER })
    expect(Number(dot.calls[0].options.delay)).toBeGreaterThanOrEqual(KEYBOARD_HOLD_MS + FOLD_MS - 60)
  })
  it('a stand-in flies over the shutting box (the box paints over the bar and the real face), which hides until it lands', () => {
    setReduced(false)
    const face = fake(FOLDED)
    const flyer = fake(FOLDED)
    flyBack(face, snap(fake(BOX)), { dot: null, bar: null, page: null, cover: COVER, flyer })
    const move = flipFrom(CHIP, FOLDED)!
    expect(flyer.calls[0].frames[0].transform).toBe(`translate(${move.dx}px, ${move.dy}px) scale(${move.s})`)
    expect(flyer.calls[0].options.delay).toBe(KEYBOARD_HOLD_MS)
    expect(face.calls).toHaveLength(1)
    expect(face.calls[0].frames.every((f) => f.opacity === 0)).toBe(true)
    expect(face.calls[0].options.duration).toBe(KEYBOARD_HOLD_MS + FOLD_MS)
  })
  it('the stand-in goes with the flight', () => {
    setReduced(false)
    let gone = false
    const flyer = Object.assign(fake(FOLDED), { remove: () => void (gone = true) })
    const stop = flyBack(fake(FOLDED), snap(fake(BOX)), { dot: null, bar: null, page: null, flyer })
    expect(gone).toBe(false)
    stop()
    expect(gone).toBe(true)
  })
  it('no keyboard up: no wait, no sinking', () => {
    setReduced(false)
    const face = fake(FOLDED)
    const ghost = fake(BOX)
    flyBack(face, snap(ghost), { dot: null, bar: null, page: null })
    expect(face.calls[0].options.delay ?? 0).toBe(0)
    expect(ghost.calls[0].frames.every((f) => f.transform === undefined)).toBe(true)
  })
  it('reduced motion: still opacity only', () => {
    setReduced(true)
    const face = fake(FOLDED)
    const ghost = fake(BOX)
    flyBack(face, snap(ghost), { dot: null, bar: null, page: null, cover: COVER })
    const props = new Set([...face.calls, ...ghost.calls].flatMap((c) => c.frames.flatMap((f) => Object.keys(f))))
    expect([...props]).toEqual(['opacity'])
  })
})
