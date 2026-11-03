// FACE MOTION POLISH (owner design 2026-11-04, cut "Face motion"):
//   fold    the chip's face flies back to the bar's end, the box clips shut
//           toward it, the draft dot pops in (300 ms);
//   send    the key presses to .92, the words leave as a toast over the box;
//   hover   a real tooltip over the folded face, never under the cursor;
//   always  transform / opacity / clip only; reduced motion = opacity only.
// Pure rules and the animations' keyframes over stand-in elements (no jsdom,
// the house way); the frames themselves are checked headless mid-flight.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { clipFrom, flipFrom, type Box } from '../src/renderer/src/prompt/face-flip'
import { BAR_MS, FOLD_MS, fliesBack, flyBack, shutInsets, type FoldSnapshot } from '../src/renderer/src/prompt/fold-flight'
import { tipPlace } from '../src/renderer/src/prompt/face-tip'
import { TipBody } from '../src/renderer/src/prompt/FaceTip'
import { PromptFace } from '../src/renderer/src/prompt/PromptFace'
import { SentToast, sentLine } from '../src/renderer/src/prompt/SentToast'

const read = (...p: string[]): string => readFileSync(join(__dirname, '../src/renderer/src', ...p), 'utf8')

type Frame = Record<string, string | number | null | undefined>
interface Call {
  readonly frames: Frame[]
  readonly options: KeyframeAnimationOptions
}
type Fake = HTMLElement & { calls: Call[]; removed: boolean }

/** An element that records what it was asked to animate. */
const fake = (rect: Box): Fake => {
  const calls: Call[] = []
  const el = {
    calls,
    removed: false,
    getBoundingClientRect: () => rect,
    animate: (frames: Frame[], options: KeyframeAnimationOptions) => {
      calls.push({ frames, options })
      return { finished: new Promise(() => undefined), cancel: () => undefined }
    },
    classList: tokens(),
    remove() {
      el.removed = true
    }
  }
  return el as unknown as Fake
}

/** A class list that only remembers. */
function tokens(): DOMTokenList & { has: Set<string> } {
  const has = new Set<string>()
  return { has, add: (c: string) => void has.add(c), remove: (c: string) => void has.delete(c), contains: (c: string) => has.has(c) } as unknown as DOMTokenList & { has: Set<string> }
}
const page = (): { classList: DOMTokenList & { has: Set<string> } } => ({ classList: tokens() })

const setReduced = (reduced: boolean): void => {
  ;(globalThis as unknown as { window: unknown }).window = {
    matchMedia: (q: string) => ({ matches: reduced && q === '(prefers-reduced-motion: reduce)' })
  }
}
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

const MOTION_PROPS = new Set(['transform', 'transformOrigin', 'opacity', 'clipPath', 'offset', 'easing'])
const propsOf = (calls: readonly Call[]): string[] => [...new Set(calls.flatMap((c) => c.frames.flatMap((f) => Object.keys(f))))]

// A 360 phone: the chip's face at the box's left, the folded face at the bar's end.
const CHIP: Box = { left: 22, top: 794, width: 24, height: 24 }
const BOX: Box = { left: 12, top: 784, width: 336, height: 44 }
const FOLDED: Box = { left: 312, top: 790, width: 34, height: 34 }

describe('which fold flies back', () => {
  const at = (folded: boolean, place: 'bar' | 'corner' | 'none', placed = place !== 'none') => ({ folded, place, placed })
  it('an open box folding where it stood (deselect, Esc, a press elsewhere)', () => {
    expect(fliesBack(at(false, 'bar'), at(true, 'bar'))).toBe(true)
    expect(fliesBack(at(false, 'corner'), at(true, 'corner'))).toBe(true)
  })
  it('never a box that was folded already, nor one that stays open', () => {
    expect(fliesBack(at(true, 'bar'), at(true, 'bar'))).toBe(false)
    expect(fliesBack(at(false, 'bar'), at(false, 'bar'))).toBe(false)
  })
  it('never across views: leaving an agent full view folds the box without a flight', () => {
    expect(fliesBack(at(false, 'none'), at(true, 'bar'))).toBe(false)
    expect(fliesBack(at(false, 'bar'), at(true, 'corner'))).toBe(false)
  })
  it("never when the bar's slot only now appears (the zoom mounts after the dock: launch, back to the stage)", () => {
    expect(fliesBack(at(false, 'bar', false), at(true, 'bar'))).toBe(false)
  })
})

describe('the fold flies back (reverse of the open)', () => {
  const snap = (ghost: Fake | null): FoldSnapshot => ({ box: BOX, face: CHIP, display: 'flex', clip: 'none', ghost })

  it("draws the folded face from the chip's place and lets it settle at the bar's end in 300 ms", () => {
    setReduced(false)
    const face = fake(FOLDED)
    flyBack(face, snap(fake(BOX)), { dot: null, bar: null, page: null })
    expect(FOLD_MS).toBe(300)
    const move = flipFrom(CHIP, FOLDED)!
    const [fly] = face.calls
    expect(fly.options.duration).toBe(FOLD_MS)
    expect(fly.frames[0].transform).toBe(`translate(${move.dx}px, ${move.dy}px) scale(${move.s})`)
    expect(fly.frames[0].transformOrigin).toBe('0 0')
    expect(fly.frames.at(-1)!.transform).toBe('none')
  })

  it('clips the box shut toward the folded face, from every side, then lets it go', () => {
    setReduced(false)
    const ghost = fake(BOX)
    flyBack(fake(FOLDED), snap(ghost), { dot: null, bar: null, page: null })
    const [shut] = ghost.calls
    expect(shut.options.duration).toBe(FOLD_MS)
    expect(String(shut.frames[0].clipPath)).toMatch(/^inset\(0px 0px 0px 0px /)
    const i = shutInsets(FOLDED, BOX)
    expect(String(shut.frames.at(-1)!.clipPath)).toContain(`inset(${i.top}px ${i.right}px ${i.bottom}px ${i.left}px `)
    expect(shut.frames.at(-1)!.opacity).toBe(0)
  })

  it('a fold mid-open shuts from where the open had got to, not from a whole box', () => {
    setReduced(false)
    const ghost = fake(BOX)
    flyBack(fake(FOLDED), { box: BOX, face: CHIP, display: 'flex', clip: 'inset(0px 0px 0px 120px round 22px)', ghost }, { dot: null, bar: null, page: null })
    expect(ghost.calls[0].frames[0].clipPath).toBe('inset(0px 0px 0px 120px round 22px)')
  })

  it('shuts onto the face: its left edge rides with it, and a taller box comes down to it', () => {
    // The phone's open box is two rows (the tools over the words): it shuts onto the face's row.
    const tall: Box = { left: 8, top: 692, width: 344, height: 80 }
    const face: Box = { left: 312, top: 733, width: 34, height: 34 }
    expect(shutInsets(face, tall)).toEqual({ top: 37, right: 2, bottom: 1, left: 300 })
    expect(shutInsets(face, tall).left).toBe(clipFrom(face, tall))
    // A wide desktop box, the face short of its right end: it closes from the right too.
    expect(shutInsets({ left: 924, top: 846, width: 34, height: 34 }, { left: 240, top: 840, width: 960, height: 48 })).toEqual({ top: 2, right: 238, bottom: 4, left: 680 })
    // Never inside out.
    const off = shutInsets({ left: 2000, top: 0, width: 34, height: 34 }, BOX)
    expect(off.left + off.right).toBeLessThanOrEqual(BOX.width)
    expect(off.top + off.bottom).toBeLessThanOrEqual(BOX.height)
  })

  it('the bar holds back while the box shuts over its place, then clips open out of the face half-way', async () => {
    setReduced(false)
    const bar = fake({ left: 8, top: 728, width: 344, height: 44 })
    const root = page()
    const ghost = fake(BOX)
    const halfway: (() => void)[] = []
    // The ghost's runs settle when told: the half-length one is the bar's cue.
    ;(ghost as unknown as { animate: unknown }).animate = (frames: Frame[], options: KeyframeAnimationOptions) => {
      ghost.calls.push({ frames, options })
      return { finished: new Promise<void>((r) => options.duration === FOLD_MS / 2 && halfway.push(r)), cancel: () => undefined }
    }
    flyBack(fake(FOLDED), snap(ghost), { dot: null, bar, page: root })
    expect(root.classList.has.has('cr-prompt-landing')).toBe(true)
    expect(bar.calls).toHaveLength(0)
    // The cue is a still run on the flight's own clock: it moves nothing.
    expect(ghost.calls.find((c) => c.options.duration === FOLD_MS / 2)!.frames.every((f) => f.transform === 'none')).toBe(true)
    halfway.forEach((settle) => settle())
    await Promise.resolve()
    await Promise.resolve()
    expect(root.classList.has.has('cr-prompt-landing')).toBe(false)
    const [open] = bar.calls
    expect(open.options.duration).toBe(BAR_MS)
    expect(String(open.frames[0].clipPath)).toMatch(/^inset\(0 0 0 \d+(\.\d+)?px round 999px\)$/)
    expect(open.frames.at(-1)!.clipPath).toBe('inset(0 0 0 0 round 999px)')
  })

  it('a re-open mid-flight lets the bar go without its unrolling (the open box stands in its place)', async () => {
    setReduced(false)
    const bar = fake({ left: 8, top: 728, width: 344, height: 44 })
    const root = page()
    const cancel = flyBack(fake(FOLDED), snap(fake(BOX)), { dot: null, bar, page: root })
    cancel()
    expect(root.classList.has.has('cr-prompt-landing')).toBe(false)
    expect(bar.calls).toHaveLength(0)
  })

  it('pops the draft dot in once the face has landed', () => {
    setReduced(false)
    const dot = fake({ left: 0, top: 0, width: 9, height: 9 })
    flyBack(fake(FOLDED), snap(fake(BOX)), { dot, bar: null, page: null })
    const [pop] = dot.calls
    expect(Number(pop.options.delay)).toBeGreaterThanOrEqual(FOLD_MS - 60)
    expect(pop.options.fill).toBe('backwards')
    expect(pop.frames[0].transform).toBe('scale(0)')
  })

  it('moves only transform, opacity and clip', () => {
    setReduced(false)
    const face = fake(FOLDED)
    const ghost = fake(BOX)
    const dot = fake({ left: 0, top: 0, width: 9, height: 9 })
    flyBack(face, snap(ghost), { dot, bar: null, page: null })
    for (const p of propsOf([...face.calls, ...ghost.calls, ...dot.calls])) expect(MOTION_PROPS.has(p)).toBe(true)
  })

  it('reduced motion: opacity only, nothing scales or clips', () => {
    setReduced(true)
    const face = fake(FOLDED)
    const ghost = fake(BOX)
    const dot = fake({ left: 0, top: 0, width: 9, height: 9 })
    const root = page()
    flyBack(face, snap(ghost), { dot, bar: fake(BOX), page: root })
    expect(propsOf([...face.calls, ...ghost.calls, ...dot.calls]).sort()).toEqual(['opacity'])
    // Nothing held back either: the bar fades back as it always has.
    expect(root.classList.has.size).toBe(0)
  })

  it('a re-open mid-flight takes the shutting box away at once', () => {
    setReduced(false)
    const ghost = fake(BOX)
    const cancel = flyBack(fake(FOLDED), snap(ghost), { dot: null, bar: null, page: null })
    expect(ghost.removed).toBe(false)
    cancel()
    expect(ghost.removed).toBe(true)
  })

  it('lets the ghost go on time even if no frame ever settles its animation (a hidden page)', async () => {
    setReduced(false)
    const ghost = fake(BOX)
    const root = page()
    flyBack(fake(FOLDED), snap(ghost), { dot: null, bar: fake(BOX), page: root })
    await new Promise((r) => setTimeout(r, FOLD_MS + 200))
    expect(ghost.removed).toBe(true)
    // Nor is the bar left hidden.
    expect(root.classList.has.size).toBe(0)
  })

  it('no chip to fly from: the box still shuts, the face only fades in', () => {
    setReduced(false)
    const face = fake(FOLDED)
    flyBack(face, { box: BOX, face: null, display: 'flex', clip: 'none', ghost: fake(BOX) }, { dot: null, bar: null, page: null })
    expect(propsOf(face.calls)).toEqual(['opacity'])
  })
})

describe('the hover tip over the folded face', () => {
  const view = { width: 1440, height: 900 }
  const face: Box = { left: 770, top: 845, width: 34, height: 34 }
  const tip = { width: 236, height: 26 }

  it('stands above the face, its right edge on the face\'s', () => {
    const at = tipPlace(face, tip, view)
    expect(at.side).toBe('above')
    expect(at.left + tip.width).toBe(face.left + face.width)
    expect(at.top + tip.height).toBeLessThan(face.top)
  })
  it('is never under the cursor: clear of the face and its 5px touch ring', () => {
    const at = tipPlace(face, tip, view)
    const ring = { top: face.top - 5, bottom: face.top + face.height + 5, left: face.left - 5, right: face.left + face.width + 5 }
    const overlaps = at.left < ring.right && at.left + tip.width > ring.left && at.top < ring.bottom && at.top + tip.height > ring.top
    expect(overlaps).toBe(false)
  })
  it('stays on the screen: clamped at the left, below the face when the top has no room', () => {
    expect(tipPlace({ left: 4, top: 845, width: 34, height: 34 }, tip, view).left).toBe(8)
    const low = tipPlace({ left: 700, top: 10, width: 34, height: 34 }, tip, view)
    expect(low.side).toBe('below')
    expect(low.top).toBeGreaterThan(10 + 34 + 5)
  })
  it('is a real tooltip: role, id and the ⏎ key', () => {
    const html = renderToStaticMarkup(
      <TipBody id="t1">
        New Claude Code agent · click, or press <kbd>⏎</kbd>
      </TipBody>
    )
    expect(html).toMatch(/role="tooltip"/)
    expect(html).toMatch(/id="t1"/)
    expect(html).toContain('New Claude Code agent · click, or press <kbd>⏎</kbd>')
  })
  it("the face is described by it and drops the title (the native tip sits under the cursor)", () => {
    const html = renderToStaticMarkup(
      <PromptFace agent={null} harness="Claude Code" mode="folded" label="New Claude Code agent" tip="New Claude Code agent · click, or press ⏎" onTap={() => undefined} />
    )
    expect(html).toMatch(/aria-describedby="[^"]+"/)
    expect(html).not.toMatch(/ title=/)
    const plain = renderToStaticMarkup(<PromptFace agent={null} harness="Claude Code" mode="empty" label="Choose who" onTap={() => undefined} />)
    expect(plain).toMatch(/ title="Choose who"/)
    expect(plain).not.toMatch(/aria-describedby/)
  })
})

describe('the words leave as a toast', () => {
  it('reads the words on one line, nothing for none', () => {
    expect(sentLine('  also keep\n the   face ')).toBe('also keep the face')
    expect(sentLine(' \n ')).toBeNull()
  })
  it('a status region always there, so the toast is announced', () => {
    expect(renderToStaticMarkup(<SentToast sent={null} />)).toMatch(/role="status"/)
    const html = renderToStaticMarkup(<SentToast sent={{ key: 1, who: 'Velvet', words: 'also keep the face' }} />)
    expect(html).toMatch(/class="cr-prompt-sent"/)
    expect(html).toContain('Velvet')
    expect(html).toContain('also keep the face')
  })
})

describe('the motion CSS contract', () => {
  const css = read('prompt', 'prompt-motion.css')
  it('the tip never takes the pointer, and touch screens never see it', () => {
    expect(css).toMatch(/\.pf-tip \{[^}]*pointer-events: none/)
    expect(css).toMatch(/@media \(hover: none\)[^{]*\{\s*\.pf-tip \{[^}]*display: none/)
  })
  it('keyframes move transform and opacity only', () => {
    const frames = [...css.matchAll(/@keyframes [\w-]+ \{([\s\S]*?)\n\}/g)].map((m) => m[1])
    expect(frames.length).toBeGreaterThan(0)
    for (const body of frames) {
      const props = [...body.matchAll(/([\w-]+):/g)].map((m) => m[1])
      for (const p of props) expect(['transform', 'opacity']).toContain(p)
    }
  })
  it('landing: the bar keeps its chrome back and shows only the face flying in', () => {
    expect(css).toMatch(/body\.cr-prompt-landing \.zv-root:not\(\[data-full='true'\]\) \.zv-controls \{[^}]*visibility: hidden/)
    expect(css).toMatch(/body\.cr-prompt-landing \.zv-root:not\(\[data-full='true'\]\) \.zv-face-slot \{[^}]*visibility: visible/)
    expect(css).toMatch(/body\.cr-prompt-landing \.zv-face-slot::before \{[^}]*visibility: hidden/)
  })
  it('reduced motion: the toast does not move', () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.cr-prompt-sent[\s\S]*animation: none/)
  })
  it('the Send key carries a ref the press animates', () => {
    expect(read('prompt', 'GlobalPrompt.tsx')).toMatch(/<button type="submit"[^>]*ref=\{sendRef\}/)
  })
})
