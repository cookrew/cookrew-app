import {
  classifyOrigin,
  pathBadgeView,
  type PathLink,
  type PathBadgeView,
  type PathState
} from '../../shared/path-badge'

/**
 * WHAT THE COMPANION KNOWS ABOUT ITS OWN LINK.
 *
 * The path badge needs two facts and nothing else: which origin this page was
 * served from, and whether the push channel is up. The first never changes for
 * the life of the page; the second changes, and nothing in the renderer was
 * subscribing to it — the reconnecting stream kept its state entirely to
 * itself and `alive` was read nowhere.
 *
 * So this is the smallest possible store: a value, a set, and a subscribe.
 * Deliberately not a hook and not tied to React, because the transport that
 * feeds it is remote-api, which knows nothing about components.
 *
 * The latency is a real measurement, not a guess — the round trip of the last
 * request the companion actually made. A synthetic ping would measure a path
 * nobody is using.
 */

export type PathLinkState = {
  readonly link: PathLink
  readonly latencyMs: number | null
  readonly desktopName: string | null
  /** A better path is being raced right now. See path/switch.ts. */
  readonly probing: boolean
}

const IDLE: PathLinkState = { link: 'live', latencyMs: null, desktopName: null, probing: false }

let state: PathLinkState = IDLE
const listeners = new Set<(next: PathLinkState) => void>()

const announce = (): void => listeners.forEach((listener) => listener(state))

export const pathLinkState = (): PathLinkState => state

export const setPathLink = (link: PathLink): void => {
  if (state.link === link) return
  state = { ...state, link }
  announce()
}

/**
 * Record a round trip. Smoothed, because one slow request on a busy Wi-Fi is
 * not the network and a number that jumps between 12 and 900 ms reads as
 * broken even when the link is fine.
 */
export const recordLatency = (ms: number): void => {
  if (!Number.isFinite(ms) || ms < 0) return
  const previous = state.latencyMs
  const next = previous === null ? Math.round(ms) : Math.round(previous * 0.7 + ms * 0.3)
  if (next === previous) return
  state = { ...state, latencyMs: next }
  announce()
}

/**
 * The companion is looking for a better way to the Mac.
 *
 * The badge says PROBING and nothing else happens — no prompt, no spinner over
 * the canvas. A probe that interrupted would be a worse experience than the
 * slow path it is trying to replace.
 */
export const setProbing = (on: boolean): void => {
  if (state.probing === on) return
  state = { ...state, probing: on }
  announce()
}

export const setDesktopName = (name: string | null): void => {
  if (state.desktopName === name) return
  state = { ...state, desktopName: name }
  announce()
}

export const subscribePathLink = (listener: (next: PathLinkState) => void): (() => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Test seam: the module is a singleton, and a test needs a clean one. */
export const resetPathLink = (): void => {
  state = IDLE
  listeners.clear()
}

const originOf = (): string => {
  try {
    return window.location.origin
  } catch {
    return ''
  }
}

const registryOf = (): string | undefined => {
  const configured = (window as unknown as { COOKREW_REGISTRY?: string }).COOKREW_REGISTRY
  return typeof configured === 'string' && configured.length > 0 ? configured : undefined
}

/** The badge's whole view, from this page's own origin and link state. */
export const currentPathBadge = (): PathBadgeView =>
  pathBadgeView({
    origin: originOf(),
    link: state.link,
    latencyMs: state.latencyMs,
    probing: state.probing,
    ...(state.desktopName ? { desktopName: state.desktopName } : {}),
    ...(registryOf() ? { registryOrigin: registryOf() as string } : {})
  })

/**
 * Where this page is, from its ORIGIN alone.
 *
 * Deliberately not `currentPathBadge().state`: that folds in the transport, so
 * a companion mid-probe would read PROBING and the switcher would then treat
 * every path — including the one it is already on — as an improvement.
 */
export const currentOriginState = (): PathState => classifyOrigin(originOf(), registryOf())

export { classifyOrigin }
