import type { CableLink, Stub, Trunk } from './cable-route'
import { isCableSignal, type CableSignal, type CableSignalKind } from '../../shared/cable-signal'

/**
 * SIGNALS ON THE CABLES — the pure half, and the feed.
 *
 * When agent A asks agent B, and when B answers, the cable between them
 * shows the traffic: a pulse travelling from the sender to the receiver,
 * like a signal along a trace on a chip. This module decides everything
 * about that and draws nothing: which signals are alive, which cable each one
 * rides, the polyline the pulse follows and in which direction, and which
 * trunks and tabs light. CableHarness.tsx sets what this returns on elements
 * it already draws.
 *
 * THE COST MODEL IS THE DESIGN. Everything here runs on a signal's arrival
 * and on its expiry — a handful of times per exchange — and never per frame.
 * Moving the pulse is a Web Animations API `transform` animation built from
 * the polyline (`pulseKeyframes`): transform IS a compositor property, where
 * `offset-distance` was not — measured, one offset-path dot cost a style
 * recalc, a PrePaint and a commit on the main thread every frame. Lighting a
 * trunk is a class on an element already on screen; the harness's route and
 * view memos keep their deps and do not re-run. A pan subscribes to nothing
 * here, so the render-count gate (tests/perf/render-count.perf.ts) sees
 * exactly what it saw before.
 *
 * THE PULSE IS A SCREEN-SIZED THING. It lives in flow coordinates so it rides
 * the viewport, but its diameter is PULSE_SCREEN_PX divided by the zoom, and
 * its speed is PULSE_SPEED_PX_S in screen pixels — so a short cable gets a
 * short trip and a long one a long trip, within bounds, and the dot is the
 * same dot at fit-all as at working distance.
 *
 * DIRECTION IS DERIVED, NOT STORED. The router merges grid edges into trunks
 * whose link set is constant along their length, so a link enters a trunk at
 * one end and leaves at the other. `signalPath` starts at the sender's stub
 * and chains trunks by endpoint until it reaches the receiver's stub. A chain
 * that breaks (an unrouted link) yields no path: the trunks still light, the
 * pulse is not shown, and nothing is invented.
 */

/**
 * How long each kind keeps its trunks lit. The answer is the one people wait
 * for; a write or a read is a glance.
 */
export const SIGNAL_TTL_MS: Readonly<Record<CableSignalKind, number>> = { ask: 2600, answer: 3200, write: 2000, read: 2000 }
/** The dot's diameter on screen, whatever the zoom. */
export const PULSE_SCREEN_PX = 12
/** How fast the dot travels, in screen pixels per second — a speed, not a duration. */
export const PULSE_SPEED_PX_S = 600
/** The trip is never shorter than a glance nor longer than the signal's own lifetime. */
export const PULSE_MIN_MS = 500
/** Fade at the end of the trip, inside the trip. */
export const PULSE_FADE_MS = 220
/**
 * A fleet of thirty can ask at once. Four pulses read as activity; forty read
 * as noise and cost forty composited layers. The oldest is dropped first.
 */
export const MAX_IN_FLIGHT = 4

export interface LiveSignal extends CableSignal {
  /** Epoch ms after which the signal is gone. */
  until: number
}

export interface Point {
  x: number
  y: number
}

const sameMoment = (a: CableSignal, b: CableSignal): boolean =>
  a.from === b.from && a.to === b.to && a.kind === b.kind

/**
 * Admit one signal to the in-flight list.
 *
 * A signal older than its own lifetime on arrival is not admitted: the
 * streams do not replay these, but a phone waking up can deliver a batch at
 * once, and old traffic lit as new is a lie about the board. A repeat of a
 * moment already in flight (a retry re-sending the same question on the
 * same cable) refreshes the stamp instead of doubling the pulse.
 */
export function admit(list: readonly LiveSignal[], signal: CableSignal, now: number): LiveSignal[] {
  const ttl = SIGNAL_TTL_MS[signal.kind]
  if (now - signal.at >= ttl) return [...list]
  const live: LiveSignal = { ...signal, until: signal.at + ttl }
  const kept = list.filter((s) => s.until > now && !sameMoment(s, signal))
  const next = [...kept, live]
  return next.length > MAX_IN_FLIGHT ? next.slice(next.length - MAX_IN_FLIGHT) : next
}

/** Drop what has run out. Returns the same array when nothing has, so a store can skip a notify. */
export function expire(list: readonly LiveSignal[], now: number): readonly LiveSignal[] {
  if (list.every((s) => s.until > now)) return list
  return list.filter((s) => s.until > now)
}

/** When the next one runs out, or null with nothing in flight — the one timer the feed arms. */
export function nextExpiry(list: readonly LiveSignal[]): number | null {
  if (list.length === 0) return null
  let min = Number.POSITIVE_INFINITY
  for (const s of list) if (s.until < min) min = s.until
  return min
}

/** The cable between two cards, whichever way round it was drawn. */
export function linkBetween(links: readonly CableLink[], from: string, to: string): CableLink | null {
  for (const l of links) {
    if ((l.a === from && l.b === to) || (l.a === to && l.b === from)) return l
  }
  return null
}

/** Which links are lit, and by what. The newest signal on a link wins. */
export interface LitLink {
  kind: CableSignalKind
  from: string
  to: string
}

export function litLinks(
  signals: readonly LiveSignal[],
  links: readonly CableLink[]
): ReadonlyMap<string, LitLink> {
  const out = new Map<string, LitLink>()
  // Oldest first, so a later signal on the same link overwrites an earlier one.
  const ordered = [...signals].sort((a, b) => a.at - b.at)
  for (const s of ordered) {
    const link = linkBetween(links, s.from, s.to)
    if (link) out.set(link.id, { kind: s.kind, from: s.from, to: s.to })
  }
  return out
}

/** The kind lighting this trunk, if any of the cables it carries is lit. */
export function trunkSignal(trunk: Pick<Trunk, 'links'>, lit: ReadonlyMap<string, LitLink>): CableSignalKind | null {
  for (const id of trunk.links) {
    const hit = lit.get(id)
    if (hit) return hit.kind
  }
  return null
}

/**
 * The kind lighting a tab — the lamp for a cable whose far end is off the
 * stage. A tab names a partner; the cable is the pair.
 */
export function tabSignal(
  lit: ReadonlyMap<string, LitLink>,
  links: readonly CableLink[],
  card: string,
  partner: string
): CableSignalKind | null {
  const link = linkBetween(links, card, partner)
  if (!link) return null
  return lit.get(link.id)?.kind ?? null
}

const EPSILON = 0.5
const near = (p: Point, x: number, y: number): boolean => Math.abs(p.x - x) < EPSILON && Math.abs(p.y - y) < EPSILON

/**
 * The polyline a pulse follows from `from`'s edge to the other card's edge,
 * through every trunk that carries the link, in travel order.
 *
 * Null when the link has no stubs (far or unrouted) or the chain cannot be
 * closed — never a partial path, because a pulse that stops in the middle of
 * a trunk reads as a cable that broke.
 */
export function signalPath(
  harness: { trunks: readonly Trunk[]; stubs: readonly Stub[] },
  linkId: string,
  from: string
): Point[] | null {
  let start: Stub | null = null
  let end: Stub | null = null
  for (const s of harness.stubs) {
    if (s.link !== linkId) continue
    if (s.card === from) start = s
    else end = s
  }
  if (!start || !end) return null
  const points: Point[] = [{ ...start.from }, { ...start.to }]
  const carrying: number[] = []
  harness.trunks.forEach((t, i) => {
    if (t.links.includes(linkId)) carrying.push(i)
  })
  const used = new Set<number>()
  let at: Point = start.to
  // One trunk per step, so the walk is bounded by the trunks that carry the link.
  for (let steps = 0; steps <= carrying.length; steps += 1) {
    if (near(at, end.to.x, end.to.y)) {
      points.push({ ...end.from })
      return points
    }
    let next: { index: number; to: Point } | null = null
    for (const i of carrying) {
      if (used.has(i)) continue
      const t = harness.trunks[i]
      if (near(at, t.x1, t.y1)) next = { index: i, to: { x: t.x2, y: t.y2 } }
      else if (near(at, t.x2, t.y2)) next = { index: i, to: { x: t.x1, y: t.y1 } }
      if (next) break
    }
    if (!next) return null
    used.add(next.index)
    at = next.to
    points.push({ ...at })
  }
  return null
}

/** The SVG path string for `offset-path: path(...)`. Kept for tests and the design page; the dot no longer uses it. */
export function pathD(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p.x)} ${round(p.y)}`).join(' ')
}

const round = (n: number): number => Math.round(n * 100) / 100

/** Length of the polyline in flow px. */
export function pathLength(points: readonly Point[]): number {
  let length = 0
  for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
  return length
}

/**
 * How long the trip takes: the path's SCREEN length at this zoom over the
 * pulse speed, never under PULSE_MIN_MS and never past the signal's lifetime
 * less its fade — so the lit trunks always outlive the dot by a little.
 */
export function pulseDuration(points: readonly Point[], zoom: number, kind: CableSignalKind): number {
  const screenPx = pathLength(points) * Math.max(zoom, 0.01)
  const travel = (screenPx / PULSE_SPEED_PX_S) * 1000
  const max = Math.max(PULSE_MIN_MS, SIGNAL_TTL_MS[kind] - PULSE_FADE_MS)
  return Math.round(Math.min(max, Math.max(PULSE_MIN_MS, travel)))
}

/** One Web Animations keyframe. `offset` is the fraction of the trip at which the dot is at this vertex. */
export interface PulseKeyframe {
  transform: string
  offset: number
  opacity: number
}

/**
 * The trip as transform keyframes: one per vertex, placed in time by the
 * distance along the path so the dot moves at one speed round every corner.
 * Fades in over the first short step and out over the last PULSE_FADE_MS
 * worth of travel. The compositor runs these; React and the main thread set
 * them once.
 */
export function pulseKeyframes(points: readonly Point[], durationMs: number): PulseKeyframe[] {
  if (points.length === 0) return []
  const total = pathLength(points)
  const fadeFraction = total === 0 ? 0 : Math.min(0.4, PULSE_FADE_MS / Math.max(durationMs, 1))
  const at = (p: Point): string => `translate(${round(p.x)}px, ${round(p.y)}px)`
  if (points.length === 1 || total === 0) {
    return [
      { transform: at(points[0]), offset: 0, opacity: 0 },
      { transform: at(points[0]), offset: 0.5, opacity: 1 },
      { transform: at(points[0]), offset: 1, opacity: 0 }
    ]
  }
  const frames: PulseKeyframe[] = []
  let walked = 0
  for (let i = 0; i < points.length; i += 1) {
    if (i > 0) walked += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    const offset = i === points.length - 1 ? 1 : round(walked / total)
    const opacity = offset <= 0 ? 0 : offset >= 1 ? 0 : offset >= 1 - fadeFraction ? round(1 - (offset - (1 - fadeFraction)) / fadeFraction) : 1
    frames.push({ transform: at(points[i]), offset, opacity })
  }
  // Fade in: fully lit a little way in, and fade out: start dimming where the last stretch begins.
  const inAt = Math.min(0.08, frames[1].offset / 2)
  const fadeStart = round(Math.max(inAt + 0.01, 1 - fadeFraction))
  const extra: PulseKeyframe[] = [
    { ...pointAt(points, total, inAt), offset: inAt, opacity: 1 },
    { ...pointAt(points, total, fadeStart), offset: fadeStart, opacity: 1 }
  ]
  const merged = [...frames, ...extra].sort((a, b) => a.offset - b.offset)
  // Two keyframes at one offset: keep the first, which is the vertex.
  return merged.filter((f, i) => i === 0 || f.offset !== merged[i - 1].offset)
}

/** The point `fraction` of the way along the polyline, as a keyframe transform. */
function pointAt(points: readonly Point[], total: number, fraction: number): { transform: string } {
  let target = fraction * total
  for (let i = 1; i < points.length; i += 1) {
    const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    if (target <= seg || i === points.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, target / seg)
      const x = points[i - 1].x + (points[i].x - points[i - 1].x) * t
      const y = points[i - 1].y + (points[i].y - points[i - 1].y) * t
      return { transform: `translate(${round(x)}px, ${round(y)}px)` }
    }
    target -= seg
  }
  return { transform: `translate(${round(points[0].x)}px, ${round(points[0].y)}px)` }
}

/**
 * THE FEED — what the harness subscribes to.
 *
 * One list, one timer. The timer is armed for the nearest expiry and nothing
 * else; with nothing in flight there is no timer, no interval and no
 * subscription to anything but the bridge. The snapshot is replaced only on
 * admit and on expiry, which is what makes `useSyncExternalStore` cheap: a
 * pan reads the same reference it read last frame.
 */
export interface SignalFeed {
  subscribe: (listener: () => void) => () => void
  snapshot: () => readonly LiveSignal[]
  /** Admit a frame off the wire. Anything that is not a signal is ignored. */
  push: (frame: unknown) => void
  /** Test seam: drop everything and disarm. */
  reset: () => void
}

export function createSignalFeed(
  now: () => number = Date.now,
  schedule: (fn: () => void, ms: number) => () => void = defaultSchedule
): SignalFeed {
  let list: readonly LiveSignal[] = []
  let cancel: (() => void) | null = null
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const l of listeners) l()
  }
  const arm = (): void => {
    cancel?.()
    cancel = null
    const at = nextExpiry(list)
    if (at === null) return
    cancel = schedule(sweep, Math.max(0, at - now()))
  }
  const sweep = (): void => {
    cancel = null
    const next = expire(list, now())
    if (next !== list) {
      list = next
      notify()
    }
    arm()
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    snapshot: () => list,
    push: (frame) => {
      if (!isCableSignal(frame)) return
      const next = admit(list, frame, now())
      list = next
      notify()
      arm()
    },
    reset: () => {
      cancel?.()
      cancel = null
      list = []
      notify()
    }
  }
}

function defaultSchedule(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms)
  return () => clearTimeout(id)
}

/** The one feed the canvas reads. */
export const signalFeed: SignalFeed = createSignalFeed()

let connected: (() => void) | null = null

/**
 * Wire the feed to the bridge once. Idempotent: the harness mounts and
 * unmounts with the canvas mode, and the subscription outlives it — a signal
 * that arrives while the harness is unmounted is simply in flight when it
 * mounts, exactly as it would be on the phone.
 */
export function connectSignalFeed(bridge: {
  onCableSignal?: (cb: (signal: unknown) => void) => () => void
}): void {
  if (connected || !bridge.onCableSignal) return
  connected = bridge.onCableSignal((frame) => signalFeed.push(frame))
}
