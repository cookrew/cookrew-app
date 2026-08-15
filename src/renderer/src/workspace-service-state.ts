/**
 * Service-state projection for the workspace switcher (v4 §1, VELVET lane).
 *
 * v4 splits "which workspace am I looking at" from "which workspaces are being
 * serviced": a HOT workspace syncs turns and accepts dispatch whether or not
 * it has focus, DORMANT is today's inactive behaviour (panes alive, sync
 * suspended, dispatch refused 409), PARKED is a factory instance between
 * engagements (herdr session stopped, ledger sealed). Once background work is
 * real, the switcher is the only place the owner can see it — hence badges.
 *
 * RENDER-ONLY. The `serviceState` field on WorkspaceMeta is Sol's (step 2) and
 * is not landed yet, so this module reads it structurally off whatever the
 * bridge hands over and never imports a type that does not exist. When Sol
 * lands it, delete the local union here and import the shared one; nothing
 * else about this file needs to change.
 */

export type ServiceState = 'hot' | 'dormant' | 'parked'

const STATES: readonly ServiceState[] = ['hot', 'dormant', 'parked']

/** Just enough of a workspace to place a badge — deliberately structural. */
export interface ServiceStateSource {
  id: string
  serviceState?: unknown
}

/**
 * The state to render for a workspace.
 *
 * A valid persisted value always wins — Sol's machine is the authority once it
 * exists. Absent (today) or unrecognised (a future state this build predates)
 * falls back to the spec's stated default, "focused = hot, others = dormant":
 * the focused workspace is attached and syncing by construction, so badging it
 * DORMANT would report a bug that isn't there, while every other workspace
 * gets the defensive dormant the lane calls for.
 */
export function serviceStateOf(ws: ServiceStateSource, isActive: boolean): ServiceState {
  const raw = ws.serviceState
  if (typeof raw === 'string' && (STATES as readonly string[]).includes(raw)) {
    return raw as ServiceState
  }
  return isActive ? 'hot' : 'dormant'
}

/** What the switcher row draws. Copy lives here so the JSX stays presentational. */
export interface ServiceBadge {
  state: ServiceState
  /** Short all-caps label. */
  label: string
  /** Hover/aria explanation — what this state means for work, not for UI. */
  title: string
  /**
   * True when the state is the unremarkable one. Dormant is the status quo for
   * every unfocused workspace, so a full-strength badge on all of them would
   * be a wall of noise; Fresco de-emphasises these rather than this module
   * deciding not to render them (an absent badge and "no information" would
   * then be indistinguishable).
   */
  muted: boolean
}

const BADGES: Record<ServiceState, Omit<ServiceBadge, 'state'>> = {
  hot: {
    label: 'HOT',
    title: 'Serviced: turns sync and dispatch is accepted, focused or not',
    muted: false
  },
  dormant: {
    label: 'DORMANT',
    title: 'Panes keep running, but sync is suspended and dispatch is refused',
    muted: true
  },
  parked: {
    label: 'PARKED',
    title: 'Session stopped and sealed on disk — resuming re-enters with its context',
    muted: false
  }
}

export function serviceBadge(state: ServiceState): ServiceBadge {
  return { state, ...BADGES[state] }
}

/**
 * Workspaces being serviced in the BACKGROUND — hot but not focused. This is
 * the number the v4 model makes possible and the closed switcher otherwise
 * hides; zero today, and zero renders nothing.
 */
export function backgroundHotCount(
  workspaces: readonly ServiceStateSource[],
  activeId: string | null | undefined
): number {
  return workspaces.filter((w) => w.id !== activeId && serviceStateOf(w, false) === 'hot').length
}
