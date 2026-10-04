/**
 * THE SCREEN WALL'S VIEW-MODEL — every number the wall draws, and no pixels.
 *
 * Switching workspace used to be a dropdown of names. A name is the one thing
 * about a workspace nobody remembers: people know "the one with three agents
 * and a browser on the right". So the wall shows each workspace as a tilted
 * screen carrying a SNAPSHOT of its canvas, and you pick the picture.
 *
 * EVERYTHING HERE IS PURE. The layout is arithmetic — an offset, a depth, an
 * angle per screen — and arithmetic that lives in a component is arithmetic
 * nobody can check. The component reads what this returns and sets it on
 * `style.transform`; it decides nothing.
 *
 * ONLY SNAPSHOTS. No workspace but the live one is ever mounted: a wall of
 * real canvases would be N ReactFlow instances, which is the version of this
 * feature that makes the app worse. A screen is an <img> and nothing else,
 * which is also why the age of that image has to be on screen (`shotAge`) —
 * a picture of forty minutes ago pretending to be now is the one way this
 * feature could lie.
 */

/** How far apart the screens sit, per width band. */
export interface WallTier {
  /** Offset of the first neighbour, in px. */
  stepA: number
  /** Each neighbour after that. */
  stepB: number
  /** How far back the first neighbour sits. */
  depth: number
  /** Each one after that. */
  depthB: number
  /** The screen's own size at this width. */
  screen: { width: number; height: number }
  perspective: number
}

/**
 * THREE BANDS, AND THE NARROW ONE IS NOT AN AFTERTHOUGHT.
 *
 * A browser card on the canvas can be 380px wide, and at that width the whole
 * idea — a ROW of screens — has to survive. Seeing one screen and two slivers
 * is the same as having no wall at all, so the narrow band shrinks the screens
 * rather than letting the neighbours fall off the edge.
 */
export function tierFor(width: number, height?: number): WallTier {
  if (height !== undefined && height > width && width < 520) return uprightTier(width)
  if (width < 520) {
    return { stepA: 136, stepB: 66, depth: 86, depthB: 62, screen: { width: 196, height: 124 }, perspective: 900 }
  }
  if (width < 760) {
    return { stepA: 212, stepB: 106, depth: 120, depthB: 88, screen: { width: 300, height: 188 }, perspective: 1500 }
  }
  return { stepA: 300, stepB: 150, depth: 150, depthB: 110, screen: { width: 430, height: 270 }, perspective: 1500 }
}

/**
 * A PHONE HELD UPRIGHT IS NOT A NARROW CARD.
 *
 * The narrow band exists for a 380px browser card on the canvas, where height
 * is as scarce as width. A phone in portrait has the same width and twice the
 * height, and the band's 196px screens left most of it empty — three stamps
 * in a dark room. So when the stage is taller than it is wide the screens
 * grow with the width instead, and the row is still a row: the centre plus a
 * neighbour fit inside the stage at every phone width there is.
 */
function uprightTier(width: number): WallTier {
  const screenWidth = Math.round(width * 0.62)
  return {
    stepA: Math.round(width * 0.42),
    stepB: Math.round(width * 0.18),
    depth: 90,
    depthB: 60,
    screen: { width: screenWidth, height: Math.round(screenWidth * 0.62) },
    perspective: 900,
  }
}

/**
 * THE LAST SCREEN IS NOT A WORKSPACE — it is where one gets made.
 *
 * The header dropdown used to be where a workspace was created, and the
 * dropdown is gone: switching is done by looking at pictures, so making a
 * new one is picking the empty screen at the end of the row. It is appended
 * AFTER the recency order, so it never sits between two real workspaces.
 */
export const NEW_WORKSPACE_ID = '__new__'

export function withNewScreen(workspaces: readonly WorkspaceFace[]): WorkspaceFace[] {
  return [...workspaces, { id: NEW_WORKSPACE_ID, name: 'New workspace', icon: '+', dir: '' }]
}

/** Screens further than this are not drawn at all — not merely transparent. */
export const WALL_VISIBLE_DEPTH = 3
/** The neighbour distance that still earns a reflection. */
const MIRROR_DEPTH = 1
/** How much darker each step back is, and how dark it is ever allowed to get. */
const SHADE_PER_STEP = 0.12
const SHADE_MAX = 0.42
/** How far the side screens turn. Enough to read as a wall, not so far they vanish. */
const TILT_DEG = 34

export interface WorkspaceFace {
  id: string
  name: string
  icon: string
  dir: string
}

export interface Snapshot {
  /** A data URL. Null when this workspace has never been left. */
  src: string | null
  /** When it was taken, epoch ms, or null with no snapshot. */
  at: number | null
}

export interface WallScreen extends WorkspaceFace {
  /** A real workspace, or the empty screen at the end where one is made. */
  kind: 'workspace' | 'new'
  snapshot: Snapshot
  /** How old the picture is, in the words the stamp shows. Null with no picture. */
  age: string | null
  /** Distance from the one being looked at. 0 is facing you. */
  distance: number
  transform: string
  zIndex: number
  /** 0 or 1 — a screen past the visible depth is not drawn, so this is binary. */
  opacity: number
  shade: number
  mirror: boolean
  picked: boolean
  /** The workspace that is live right now, which is not always the picked one. */
  live: boolean
}

/**
 * THE ORDER IS MOST-RECENTLY-USED. (Which screen it OPENS on is a separate
 * question with its own answer — see `openingPick`.)
 *
 * Positional order would make the wall a place to build spatial memory in,
 * which is the argument against this. It loses to the thing people actually
 * do: bounce between two workspaces. MRU puts the one you were last in
 * directly beside the one you are in, so the common move is one step, and the
 * picture on each screen — not its position — is what identifies it.
 */
export function mruOrder(
  workspaces: readonly WorkspaceFace[],
  recent: readonly string[]
): WorkspaceFace[] {
  const byId = new Map(workspaces.map((w) => [w.id, w]))
  const out: WorkspaceFace[] = []
  for (const id of recent) {
    const found = byId.get(id)
    if (found) {
      out.push(found)
      byId.delete(id)
    }
  }
  // Anything the recency list has never seen keeps the store's own order.
  for (const w of workspaces) if (byId.has(w.id)) out.push(w)
  return out
}

/**
 * WHICH SCREEN THE WALL OPENS ON — the last one you were in, not this one.
 *
 * Opening on the CURRENT workspace looked obvious and was wrong twice over.
 * It pre-selects the one place you are already standing, so the first key is
 * always a correction; and because MRU keeps the live workspace at the head,
 * the wall would open with every screen to the right of it and a dead half
 * to the left — the one composition a reader would see every single time.
 *
 * Opening on the previous one is the Alt+Tab semantic: the thing you most
 * likely want is already picked, Enter goes straight there, and the live
 * workspace sits to its left where it balances the row.
 */
export function openingPick(count: number): number {
  return count > 1 ? 1 : 0
}

/** Move the pick, wrapping. A wall of one never moves. */
export function stepPick(pick: number, count: number, by: number): number {
  if (count <= 0) return 0
  return (((pick + by) % count) + count) % count
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How old the picture is, short enough for a corner stamp.
 *
 * "just now" rather than "0m ago" because a stamp reading zero looks like a
 * bug, and under a minute the distinction it is drawing does not exist.
 */
export function shotAge(at: number | null, now: number): string | null {
  if (at === null) return null
  const ms = Math.max(0, now - at)
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)}m ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h ago`
  return `${Math.floor(ms / DAY)}d ago`
}

export interface WallInput {
  workspaces: readonly WorkspaceFace[]
  /** Ids newest-first. The live one is normally at its head. */
  recent: readonly string[]
  activeId: string
  pick: number
  width: number
  /** The stage's height, when known — it is what tells a phone from a card. */
  height?: number
  shots: Readonly<Record<string, Snapshot>>
  now: number
}

export interface WallView {
  tier: WallTier
  screens: WallScreen[]
  /** The one facing the reader, or null on an empty wall. */
  picked: WallScreen | null
}

/**
 * Where every screen sits, what it carries, and how old that is.
 *
 * The transform is built here rather than in CSS because the position depends
 * on WHICH screen is picked, and a rule that changes with state is a rule a
 * stylesheet cannot hold. What CSS keeps is everything that does not move.
 */
export function wallView(input: WallInput): WallView {
  const tier = tierFor(input.width, input.height)
  // The NEW screen goes last whatever recency says; it is not somewhere
  // anybody has been.
  const ordered = mruOrder(input.workspaces, input.recent).sort(
    (a, b) => Number(a.id === NEW_WORKSPACE_ID) - Number(b.id === NEW_WORKSPACE_ID)
  )
  const pick = ordered.length === 0 ? 0 : stepPick(input.pick, ordered.length, 0)
  const screens = ordered.map((face, index) => {
    const delta = index - pick
    const distance = Math.abs(delta)
    const sign = Math.sign(delta)
    const x = distance === 0 ? 0 : tier.stepA * sign + tier.stepB * (delta - sign)
    const z = distance === 0 ? 0 : -tier.depth - (distance - 1) * tier.depthB
    const rotate = distance === 0 ? 0 : delta < 0 ? TILT_DEG : -TILT_DEG
    const scale = distance === 0 ? 1 : 0.94
    const kind: WallScreen['kind'] = face.id === NEW_WORKSPACE_ID ? 'new' : 'workspace'
    // Nothing has ever been photographed on the NEW screen, whatever a stray
    // entry under its id might claim.
    const snapshot = kind === 'new' ? { src: null, at: null } : (input.shots[face.id] ?? { src: null, at: null })
    return {
      ...face,
      kind,
      snapshot,
      age: shotAge(snapshot.at, input.now),
      distance,
      transform: `translateX(${x}px) translateZ(${z}px) rotateY(${rotate}deg) scale(${scale})`,
      zIndex: 50 - distance,
      opacity: distance > WALL_VISIBLE_DEPTH ? 0 : 1,
      shade: Math.min(distance * SHADE_PER_STEP, SHADE_MAX),
      // Under the picked screen that space belongs to the label, and two
      // things in one place is how both become unreadable.
      mirror: distance === MIRROR_DEPTH,
      picked: distance === 0,
      live: face.id === input.activeId,
    }
  })
  return { tier, screens, picked: screens[pick] ?? null }
}

/**
 * THE HANDOFF, as numbers (FLIP).
 *
 * The picked screen has to arrive exactly on the canvas viewport, because the
 * live canvas mounts underneath it while it grows and the seam between the two
 * must not be visible. Measuring both rects and solving for one transform is
 * the only way that is exact; animating width and height would be a layout
 * animation, which is both wrong here and expensive.
 */
export function flipOnto(from: DOMRectLike, to: DOMRectLike): string {
  const scale = Math.max(to.width / Math.max(from.width, 1), to.height / Math.max(from.height, 1))
  const dx = to.left + to.width / 2 - (from.left + from.width / 2)
  const dy = to.top + to.height / 2 - (from.top + from.height / 2)
  return `translate(${dx}px, ${dy}px) scale(${scale})`
}

export interface DOMRectLike {
  left: number
  top: number
  width: number
  height: number
}
