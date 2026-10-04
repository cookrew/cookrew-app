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
 * Moving the pulse is CSS (`offset-distance` in a keyframe, which Chromium
 * runs on the compositor); lighting a trunk is a class on an element already
 * on screen; the harness's route and view memos keep their deps and do not
 * re-run. A pan subscribes to nothing here, so the render-count gate
 * (tests/perf/render-count.perf.ts) sees exactly what it saw before.
 *
 * DIRECTION IS DERIVED, NOT STORED. The router merges grid edges into trunks
 * whose link set is constant along their length, so a link enters a trunk at
 * one end and leaves at the other. `signalPath` starts at the sender's stub
 * and chains trunks by endpoint until it reaches the receiver's stub. A chain
 * that breaks (an unrouted link) yields no path: the trunks still light, the
 * pulse is not shown, and nothing is invented.
 */

/** How long each kind stays on the cable. The answer is the one people wait for. */
export const SIGNAL_TTL_MS: Readonly<Record<CableSignalKind, number>> = { ask: 2600, answer: 3200 }
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

/** The SVG path string for `offset-path: path(...)`. */
export function pathD(points: readonly Point[]): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${round(p.x)} ${round(p.y)}`).join(' ')
}

const round = (n: number): number => Math.round(n * 100) / 100

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
