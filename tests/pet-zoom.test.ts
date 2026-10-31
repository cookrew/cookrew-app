// THE PET ZOOM (pets/pet-zoom.ts): face → card → full view as one semantic
// zoom. The step machine is tested with a fake View Transition and fake
// elements; the wiring and the pseudo-element styles by their source.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CARD_PARTS, FACE_PARTS, FULL_PARTS, ZOOM_CLASS, canZoom, findParts, partName, waitFor, zoomStep, type PartMap, type ZoomEnv } from '../src/renderer/src/pets/pet-zoom'

const el = (tag: string): Element => ({ tag, style: { viewTransitionName: '' } }) as unknown as Element
const nameOf = (e: Element | null | undefined): string => (e as unknown as { style: { viewTransitionName: string } }).style.viewTransitionName

function fakeEnv(over: Partial<ZoomEnv> = {}) {
  const classes = new Set<string>()
  const log: string[] = []
  let finish: () => void = () => undefined
  let run: (() => Promise<void>) | null = null
  const env: ZoomEnv = {
    reducedMotion: false,
    root: { classList: { add: (c) => void classes.add(c), remove: (c) => void classes.delete(c) } },
    startViewTransition: (update) => {
      run = update
      return { finished: new Promise<void>((resolve) => (finish = resolve)) }
    },
    ...over
  }
  return {
    env,
    classes,
    log,
    /** The browser has captured the old view and calls the update. */
    capture: async () => run?.(),
    /** The animation ends. */
    end: async () => {
      finish()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

describe('a zoom step', () => {
  it('names the parts it leaves, lands the same names on the next level, and unnames all when it ends', async () => {
    const f = fakeEnv()
    const face: PartMap = { card: el('button'), face: el('avatar'), name: el('tag') }
    const card: PartMap = { card: el('card'), face: el('card-face'), name: el('card-name'), turn: el('turn') }
    let drawn = false
    expect(zoomStep(f.env, { from: face, update: () => void (drawn = true), to: () => card })).toBe(true)
    expect(nameOf(face.card)).toBe('pet-card')
    expect(nameOf(face.name)).toBe('pet-name')
    expect(f.classes.has(ZOOM_CLASS)).toBe(true)
    await f.capture()
    expect(drawn).toBe(true)
    expect(nameOf(face.card)).toBe('')
    expect(nameOf(card.card)).toBe('pet-card')
    expect(nameOf(card.face)).toBe('pet-face')
    expect(nameOf(card.turn)).toBe('pet-turn')
    await f.end()
    for (const part of Object.values(card)) expect(nameOf(part)).toBe('')
    expect(f.classes.has(ZOOM_CLASS)).toBe(false)
  })

  it('does nothing when the page cannot zoom (no View Transitions, or reduced motion): the caller takes the plain step', () => {
    let drawn = false
    const face: PartMap = { card: el('button') }
    expect(zoomStep(fakeEnv({ startViewTransition: undefined }).env, { from: face, update: () => void (drawn = true), to: () => ({}) })).toBe(false)
    expect(zoomStep(fakeEnv({ reducedMotion: true }).env, { from: face, update: () => void (drawn = true), to: () => ({}) })).toBe(false)
    expect(drawn).toBe(false)
    expect(nameOf(face.card)).toBe('')
    expect(canZoom(fakeEnv().env)).toBe(true)
  })

  it('a step cut short by a newer one leaves the newer step its names and the zoom class', async () => {
    const first = fakeEnv()
    const shared = fakeEnv()
    const card: PartMap = { card: el('card'), turn: el('turn') }
    zoomStep(first.env, { from: { card: el('button') }, update: () => undefined, to: () => card })
    await first.capture()
    // The second click: the card is now what is left behind.
    zoomStep({ ...shared.env, root: first.env.root }, { from: card, update: () => undefined, to: () => ({ card: el('stage') }) })
    expect(nameOf(card.card)).toBe('pet-card')
    await first.end()
    expect(nameOf(card.card)).toBe('pet-card')
    expect(first.classes.has(ZOOM_CLASS)).toBe(true)
  })

  it('waits on tasks for the next level, and gives up after its time', async () => {
    let ready = false
    setTimeout(() => (ready = true), 20)
    const t0 = Date.now()
    await waitFor(() => ready, 400, 5)
    expect(ready).toBe(true)
    expect(Date.now() - t0).toBeLessThan(200)
    const t1 = Date.now()
    await waitFor(() => false, 30, 5)
    expect(Date.now() - t1).toBeGreaterThanOrEqual(25)
  })
})

describe('the parts at each level', () => {
  it('finds a level’s parts under its root, the root itself being the card', () => {
    const found = new Map<string, Element>([['.cr-pet-card-face', el('f')], ['.cr-pet-card-name', el('n')]])
    const root = { querySelector: (s: string) => found.get(s) ?? null } as unknown as Element
    const parts = findParts(root, CARD_PARTS, true)
    expect(parts.card).toBe(root)
    expect(parts.face).toBe(found.get('.cr-pet-card-face'))
    expect(parts.turn).toBeNull()
    expect(findParts(null, CARD_PARTS, true)).toEqual({})
  })

  it('maps face → card → full view the way the owner asked: the name ends in the route, the turn in the transcript, the box in the dock', () => {
    expect(FACE_PARTS.name).toBe('.cr-pet-name')
    expect(CARD_PARTS.name).toBe('.cr-pet-card-name')
    expect(FULL_PARTS.name).toBe('.cr-route-agent .cr-route-here')
    expect(FULL_PARTS.card).toBe('.cr-stage-main')
    expect(FULL_PARTS.ask).toBe('.cr-dock.zoomed .dock-send')
    expect(partName('turn')).toBe('pet-turn')
  })

  it('is wired into the troop: the first click zooms to the card, the second (or OPEN) to the full view', () => {
    const troop = readFileSync('src/renderer/src/pets/PetTroop.tsx', 'utf8')
    expect(troop).toContain("if (petClick(openId, id) === 'full') {\n      zoomToFull(id)")
    expect(troop).toContain('from: findParts(face, FACE_PARTS, true)')
    expect(troop).toContain('to: () => findParts(document, FULL_PARTS, false)')
    expect(troop).toMatch(/open: \(\) => \{\s+if \(openId\) zoomToFull\(openId\)/)
    const css = readFileSync('src/renderer/src/pets/pets.css', 'utf8')
    expect(css).toMatch(/:root\.pet-zoom::view-transition \{\s*pointer-events: none;/)
    expect(css).toMatch(/:root\.pet-zoom::view-transition-old\(root\),\s*:root\.pet-zoom::view-transition-new\(root\) \{\s*animation: none;/)
  })
})
