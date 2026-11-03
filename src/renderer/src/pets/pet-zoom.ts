/**
 * A PET ZOOMS, ONE CLICK AT A TIME (owner, 2026-10-31): a tiny round face;
 * click, and it zooms semantically into its card; click again, and the card
 * zooms into the full view (the stage). Semantic, not a pop: the same parts
 * travel from one level to the next and keep who they are —
 *
 *   face             card                      full view
 *   ring          →  the card itself        →  the stage's middle
 *   avatar        →  the card's avatar      →  the agent mark in the header route
 *   name tag      →  the card's name        →  the agent's name in the header route
 *                    the latest turn        →  the transcript
 *                    the prompt box         →  the dock's composer
 *
 * The browser's View Transitions draw it: each part gets a name in the old
 * view and the same name in the new one, and the compositor moves it (only
 * transform and opacity). Parts a level adds fade in once the card has room
 * for them, so no words are ever seen squashed. Without View Transitions, or
 * with reduced motion, the caller takes the plain step (the card's own grow,
 * in pet-morph.ts, still plays from the face).
 */

export const PET_PARTS = ['card', 'face', 'name', 'meta', 'turn', 'ask', 'open', 'x'] as const
export type PetPart = (typeof PET_PARTS)[number]
export type PartMap = Partial<Record<PetPart, Element | null>>

/** The class the root carries while a pet zooms: its pseudo-elements are styled under it (pets.css). */
export const ZOOM_CLASS = 'pet-zoom'
/** How long a step may wait for the next level to be drawn before it shows what is there. */
export const NEXT_LEVEL_WAIT_MS = 400

export const partName = (part: PetPart): string => `pet-${part}`

/** Where each part is in a pet's face (the face button is the ring). */
export const FACE_PARTS: Partial<Record<Exclude<PetPart, 'card'>, string>> = {
  face: '.vi-avatar, .cr-pet-note-face, img, svg',
  name: '.cr-pet-name'
}
/** Where each part is in an open card (.cr-pet-card). */
export const CARD_PARTS: Partial<Record<Exclude<PetPart, 'card'>, string>> = {
  face: '.cr-pet-card-face',
  name: '.cr-pet-card-name',
  meta: '.cr-pet-card-meta',
  turn: '.cr-pet-card-turn',
  ask: '.cr-pet-card-ask',
  open: '.cr-pet-card-open',
  x: '.cr-pet-card-x'
}
/** Where each part is in the full view, from the document. */
export const FULL_PARTS: Partial<Record<PetPart, string>> = {
  card: '.cr-stage-main',
  turn: '.cr-stage-main > *',
  name: '.cr-route-agent .cr-route-here',
  face: '.cr-route-agent .cr-route-here svg',
  ask: '.cr-dock.zoomed .dock-send'
}

interface Queryable {
  querySelector: (selector: string) => Element | null
}

/** The parts found under `root`, with `card` as the root itself unless the table names it. */
export function findParts(root: (Queryable & Element) | Queryable | null, table: Partial<Record<PetPart, string>>, cardIsRoot: boolean): PartMap {
  if (!root) return {}
  const out: PartMap = {}
  if (cardIsRoot) out.card = root as Element
  for (const part of PET_PARTS) {
    const selector = table[part]
    if (selector) out[part] = root.querySelector(selector)
  }
  return out
}

type Styled = Element & { style?: { viewTransitionName?: string } }

/** The parts the newest step named: an older step, cut short, must not unname them. */
let claimed = new Set<Element>()

function nameAll(parts: PartMap, on: boolean, keep: ReadonlySet<Element> = new Set()): void {
  for (const part of PET_PARTS) {
    const el = parts[part] as Styled | null | undefined
    if (!el?.style || keep.has(el)) continue
    el.style.viewTransitionName = on ? partName(part) : ''
  }
}

const elementsOf = (parts: PartMap): Element[] => PET_PARTS.map((part) => parts[part]).filter((el): el is Element => !!el)

interface ViewTransitionLike {
  finished: Promise<unknown>
}
export interface ZoomEnv {
  startViewTransition?: (update: () => Promise<void>) => ViewTransitionLike
  reducedMotion: boolean
  root: { classList: { add: (c: string) => void; remove: (c: string) => void } }
}

/** The page's own environment, read when a step starts. */
export function pageZoomEnv(): ZoomEnv {
  const doc = document as Document & { startViewTransition?: (update: () => Promise<void>) => ViewTransitionLike }
  return {
    startViewTransition: typeof doc.startViewTransition === 'function' ? doc.startViewTransition.bind(doc) : undefined,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    root: document.documentElement
  }
}

export const canZoom = (env: ZoomEnv): boolean => !!env.startViewTransition && !env.reducedMotion

/**
 * One step of the zoom: the parts of the level being left are named, the
 * update draws the next level, and the same names go on its parts. Returns
 * false, having done nothing, when the page cannot zoom: the caller takes
 * the plain step.
 */
export function zoomStep(env: ZoomEnv, step: { from: PartMap; update: () => void | Promise<void>; to: () => PartMap }): boolean {
  if (!canZoom(env)) return false
  let landed: PartMap = {}
  const mine = new Set(elementsOf(step.from))
  claimed = mine
  nameAll(step.from, true)
  env.root.classList.add(ZOOM_CLASS)
  const transition = env.startViewTransition!(async () => {
    nameAll(step.from, false)
    await step.update()
    landed = step.to()
    for (const el of elementsOf(landed)) mine.add(el)
    nameAll(landed, true)
  })
  const done = (): void => {
    // A newer step took over: leave its parts named, and the zoom class on.
    const newer = claimed !== mine
    const keep = newer ? claimed : new Set<Element>()
    nameAll(step.from, false, keep)
    nameAll(landed, false, keep)
    if (!newer) env.root.classList.remove(ZOOM_CLASS)
  }
  transition.finished.then(done, done)
  return true
}

/**
 * Wait (on tasks, not frames: a view transition holds rendering while its
 * update runs) until `ready` holds, or `ms` passes.
 */
export function waitFor(ready: () => boolean, ms = NEXT_LEVEL_WAIT_MS, every = 16): Promise<void> {
  return new Promise((resolve) => {
    const until = Date.now() + ms
    const look = (): void => {
      if (ready() || Date.now() >= until) resolve()
      else setTimeout(look, every)
    }
    look()
  })
}
