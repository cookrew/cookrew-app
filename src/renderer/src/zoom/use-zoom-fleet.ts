/**
 * THE ZOOM'S DEVICES, from real data: what the navigator's "devices" and
 * "device" stops draw. Two feeds, joined per machine:
 *
 *   this desktop   its own fleet feed (subscribeZoomFleet: a snapshot, then
 *                  deltas, folded as /me folds its streams): every workspace,
 *                  focused or background, with its agents, their wired notes
 *                  and browsers, the loose tray and the counts. Until the feed
 *                  lands, or on a surface without one, its workspace list by name.
 *   the account    every desktop the registry lists for the signed-in account
 *                  (zoomFleetMachines): name, presence, kind, workspace names.
 *                  Another Mac's agents are not readable from here — that takes
 *                  that Mac's own pairing token — so its workspaces are names
 *                  with counts unknown (null), never zeros.
 *
 * One store per window, started by its first reader and stopped a moment after
 * its last (StrictMode's mount-unmount-mount must not redial). Out of sight the
 * feed closes (an open stream holds the board's sampler on main) and the
 * account is not asked; in sight again, both come back.
 */
import { useSyncExternalStore } from 'react'
import type { WorkspaceList } from '../../../shared/model'
import type { FleetAgent, FleetAttachment, FleetEvent, FleetSnapshot, FleetWorkspace, MachineDisplay, MachineProfile, WorkspaceTrait } from '../../../shared/fleet'
import type { AccountMachine, AccountMachines, AccountMachinesRefusal } from '../../../shared/zoom-fleet'
import { foldFleet } from '../../../shared/fleet-fold'
import { DECK_SHOWN } from './zoom-model'
import { cookrew, type CookrewApi } from '../api'

export type ZoomFleetAgent = FleetAgent
export type ZoomFleetAttachment = FleetAttachment

export interface ZoomCounts {
  agents: number
  notes: number
  browsers: number
  /** Agents waiting on the owner. */
  waiting: number
  /** Agents thinking right now. */
  working: number
}

export interface ZoomFleetWorkspace {
  id: string
  name: string
  icon: string | null
  traits: WorkspaceTrait[]
  /** The one its desktop shows (canvas in memory, browsers running). */
  focused: boolean
  /** Seated from the desktop's feed. False = a name only: no agents, no tray, counts null. */
  live: boolean
  /** Creation order, as the desktop keeps them. */
  agents: ZoomFleetAgent[]
  /** Notes and browsers wired to no agent. */
  loose: ZoomFleetAttachment[]
  counts: ZoomCounts | null
  /** Its newest browser: the feed's, else the last one it lists. Null for a name only. */
  newest: ZoomFleetAttachment | null
}

/**
 * live        seated from this desktop's feed
 * connecting  the feed is opening (or reopening): what is shown is the last
 *             snapshot, else the workspace names
 * listed      names only: another desktop, or a surface without a feed
 */
export type ZoomMachineDetail = 'live' | 'connecting' | 'listed'

export interface ZoomFleetMachine {
  /** Registry desktop id; LOCAL_MACHINE_ID for this desktop when the account does not list it. */
  id: string
  name: string
  /** The desktop this surface runs on, or the one the phone reads. */
  local: boolean
  online: boolean
  lastSeenAt: number | null
  appVersion: string | null
  profile: MachineProfile | null
  /** This desktop's display, from its own feed; another desktop's is not known. */
  display?: MachineDisplay | null
  detail: ZoomMachineDetail
  focusedWorkspaceId: string | null
  workspaces: ZoomFleetWorkspace[]
  /** Summed over the workspaces; null unless every one is live. */
  counts: ZoomCounts | null
}

export interface ZoomFleet {
  /** This desktop first, then the account's others in the registry's order. */
  machines: ZoomFleetMachine[]
  /** A failure worth saying (not a missing feature, not being signed out); the rows still show what is known. */
  error: string | null
  loading: boolean
}

/** This desktop's id when the account does not list it (no account, or not registered yet). */
export const LOCAL_MACHINE_ID = 'this-desktop'

export const LOAD_GRACE_MS = 2_500
export const STOP_GRACE_MS = 1_000
/** The registry's presence is asked again on this clock while in sight. */
export const ACCOUNT_REFRESH_MS = 60_000
export const RETRY_MS = 2_000
export const RETRY_MAX_MS = 30_000

// ── composing ───────────────────────────────────────────────────────────────

export type FeedLink = 'connecting' | 'live' | 'none'

export interface FleetParts {
  snapshot: FleetSnapshot | null
  /** 'none' = this surface has no feed. */
  link: FeedLink
  list: WorkspaceList | null
  /** This desktop's name from machineName, for when nothing better is known. */
  name: string | null
  account: AccountMachines | null
}

const countsOf = (workspace: FleetWorkspace): ZoomCounts => ({
  ...workspace.counts,
  waiting: workspace.agents.filter((a) => a.phase === 'waiting').length,
  working: workspace.agents.filter((a) => a.phase === 'thinking').length
})

const sumCounts = (workspaces: readonly ZoomFleetWorkspace[]): ZoomCounts | null =>
  workspaces.reduce<ZoomCounts | null>(
    (sum, w) =>
      sum && w.counts
        ? {
            agents: sum.agents + w.counts.agents,
            notes: sum.notes + w.counts.notes,
            browsers: sum.browsers + w.counts.browsers,
            waiting: sum.waiting + w.counts.waiting,
            working: sum.working + w.counts.working
          }
        : null,
    { agents: 0, notes: 0, browsers: 0, waiting: 0, working: 0 }
  )

const liveWorkspace = (workspace: FleetWorkspace): ZoomFleetWorkspace => ({
  id: workspace.id,
  name: workspace.name,
  icon: workspace.icon,
  traits: workspace.traits ?? [],
  focused: workspace.state === 'focused',
  live: true,
  agents: workspace.agents,
  loose: workspace.loose,
  counts: countsOf(workspace),
  newest: workspace.newest ?? lastBrowserOf(workspace)
})

/**
 * WHAT A TILE'S DECK SHOWS (owner, 2026-11-04: artifacts on the same page as
 * the agents, not only numbers): the newest browser on top, then the newest
 * note, so a workspace of both shows both, then whatever came last. Each thing
 * once, however many agents wear it.
 */
export function deckOf(w: Pick<ZoomFleetWorkspace, 'agents' | 'loose' | 'newest'>): ZoomFleetAttachment[] {
  const listed = [...w.agents.flatMap((a) => a.attachments ?? []), ...w.loose].reverse()
  const note = listed.find((a) => a.kind === 'note')
  const order = [w.newest, note, ...listed].filter((a): a is ZoomFleetAttachment => !!a)
  return [...new Map(order.map((a) => [a.id, a])).values()].slice(0, DECK_SHOWN)
}

/** A desktop older than the feed's `newest`: the last browser it lists, its tray before its agents'. */
function lastBrowserOf(workspace: FleetWorkspace): FleetAttachment | null {
  const listed = [...workspace.agents.flatMap((a) => a.attachments), ...workspace.loose]
  return listed.findLast((a) => a.kind === 'browser') ?? null
}

const listedWorkspace = (workspace: { id: string; name: string }, focusedId: string | null): ZoomFleetWorkspace => ({
  id: workspace.id,
  name: workspace.name,
  icon: null,
  traits: [],
  focused: workspace.id === focusedId,
  live: false,
  agents: [],
  loose: [],
  counts: null,
  newest: null
})

const machineOf = (row: AccountMachine): ZoomFleetMachine => ({
  id: row.id,
  name: row.name,
  local: false,
  online: row.online,
  lastSeenAt: row.lastSeenAt,
  appVersion: row.appVersion,
  profile: row.profile,
  detail: 'listed',
  focusedWorkspaceId: null,
  workspaces: row.workspaces.map((w) => listedWorkspace(w, null)),
  counts: null
})

function localMachine(parts: FleetParts, row: AccountMachine | undefined): ZoomFleetMachine {
  const { snapshot, list } = parts
  const focusedWorkspaceId = snapshot ? snapshot.focusedWorkspaceId : (list?.activeId || null)
  const workspaces = snapshot
    ? snapshot.workspaces.map(liveWorkspace)
    : list
      ? list.workspaces.map((w) => listedWorkspace(w, focusedWorkspaceId))
      : (row?.workspaces ?? []).map((w) => listedWorkspace(w, null))
  return {
    id: row?.id ?? LOCAL_MACHINE_ID,
    name: snapshot?.machine.name || row?.name || parts.name || 'This desktop',
    local: true,
    // Read by this surface right now: up, whatever the registry last heard.
    online: true,
    lastSeenAt: snapshot?.at ?? row?.lastSeenAt ?? null,
    appVersion: snapshot?.machine.appVersion ?? row?.appVersion ?? null,
    profile: snapshot?.machine.profile ?? row?.profile ?? null,
    display: snapshot?.machine.display ?? null,
    detail: parts.link === 'none' ? 'listed' : parts.link === 'live' && snapshot ? 'live' : 'connecting',
    focusedWorkspaceId,
    workspaces,
    counts: snapshot ? sumCounts(workspaces) : null
  }
}

/** Every machine the navigator can draw: this desktop first, then the account's others. */
export function composeFleet(parts: FleetParts): ZoomFleetMachine[] {
  const rows = parts.account?.ok ? parts.account.machines : []
  const current = rows.find((row) => row.current)
  return [localMachine(parts, current), ...rows.filter((row) => row !== current).map(machineOf)]
}

const ACCOUNT_SENTENCE: Partial<Record<AccountMachinesRefusal, string>> = {
  offline: 'Your other devices could not be listed: cookrew.dev did not answer.',
  refused: 'Your other devices could not be listed: cookrew.dev refused.',
  malformed: 'Your other devices could not be listed: cookrew.dev sent an answer this app cannot read.',
  failed: 'Your other devices could not be asked for.'
}

export const LOCAL_UNREADABLE = 'This desktop’s workspaces could not be read.'

// ── the store ───────────────────────────────────────────────────────────────

export type FleetApi = Partial<Pick<CookrewApi, 'subscribeZoomFleet' | 'zoomFleetMachines' | 'listWorkspaces' | 'machineName'>>

/** Whether the window is out of sight, and word when that changes. */
export interface Sight {
  hidden: () => boolean
  watch: (changed: () => void) => () => void
}

export interface FleetStoreOptions {
  graceMs?: number
  stopGraceMs?: number
  refreshMs?: number
  /** The first retry after a refused feed; each next one doubles, up to RETRY_MAX_MS. */
  retryMs?: number
  sight?: Sight | null
}

export interface ZoomFleetStore {
  subscribe: (listener: () => void) => () => void
  get: () => ZoomFleet
}

interface State extends FleetParts {
  listFailed: boolean
  graceOver: boolean
}

const isAnswer = (value: unknown): value is AccountMachines =>
  typeof value === 'object' && value !== null && typeof (value as { ok?: unknown }).ok === 'boolean'

export function createZoomFleetStore(api: () => FleetApi, options: FleetStoreOptions = {}): ZoomFleetStore {
  const { graceMs = LOAD_GRACE_MS, stopGraceMs = STOP_GRACE_MS, refreshMs = ACCOUNT_REFRESH_MS, retryMs = RETRY_MS, sight = null } = options
  const listeners = new Set<() => void>()
  let state: State = { snapshot: null, link: 'connecting', list: null, name: null, account: null, listFailed: false, graceOver: false }
  let fleet: ZoomFleet = { machines: composeFleet(state), error: null, loading: true }
  let accountKey = ''
  let running = false
  let release: (() => void) | null = null
  let generation = 0
  let retries = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  let stopTimer: ReturnType<typeof setTimeout> | null = null
  let refreshTimer: ReturnType<typeof setInterval> | null = null
  let unwatch: (() => void) | null = null
  let asking = false

  const derive = (s: State): ZoomFleet => {
    const hasAccount = typeof api().zoomFleetMachines === 'function'
    const localSettled = s.snapshot !== null || (s.link === 'none' && (s.list !== null || s.listFailed))
    const accountSettled = !hasAccount || s.account !== null
    const localError = s.snapshot === null && s.list === null && s.listFailed && s.link === 'none' ? LOCAL_UNREADABLE : null
    const accountError = s.account && !s.account.ok ? (ACCOUNT_SENTENCE[s.account.reason] ?? null) : null
    return {
      machines: composeFleet(s),
      error: [localError, accountError].filter(Boolean).join(' ') || null,
      loading: !s.graceOver && !(localSettled && accountSettled)
    }
  }

  const set = (patch: Partial<State>): void => {
    state = { ...state, ...patch }
    fleet = derive(state)
    for (const listener of listeners) listener()
  }

  // ── the feed ──
  const closeFeed = (): void => {
    generation += 1
    release?.()
    release = null
    if (retryTimer !== null) clearTimeout(retryTimer)
    retryTimer = null
    if (state.link === 'live') set({ link: 'connecting' })
  }

  const retry = (): void => {
    const delay = Math.min(retryMs * 2 ** retries, RETRY_MAX_MS)
    retries += 1
    retryTimer = setTimeout(() => {
      retryTimer = null
      if (running && !sight?.hidden()) openFeed()
    }, delay)
  }

  const onEvent = (event: FleetEvent): void => {
    const folded = foldFleet(state.snapshot, event)
    if (folded.ok) {
      retries = 0
      set({ snapshot: folded.snapshot, link: 'live' })
      return
    }
    // A missed delta cannot be rebuilt from the ones after it: reopen, which starts on a snapshot.
    closeFeed()
    openFeed()
  }

  function openFeed(): void {
    if (release !== null || retryTimer !== null) return
    const subscribe = api().subscribeZoomFleet
    if (!subscribe) {
      if (state.link !== 'none') set({ link: 'none' })
      return
    }
    const mine = ++generation
    let refusedEarly = false
    const opened = subscribe(
      (event) => {
        if (mine === generation) onEvent(event)
      },
      () => {
        if (mine !== generation) return
        if (release === null) {
          refusedEarly = true
          return
        }
        closeFeed()
        retry()
      }
    )
    if (refusedEarly) {
      opened()
      retry()
      return
    }
    release = opened
  }

  // ── the account and the local list ──
  const askAccount = async (): Promise<void> => {
    const ask = api().zoomFleetMachines
    if (!ask || asking) return
    asking = true
    let answer: AccountMachines
    try {
      const raw: unknown = await ask()
      answer = isAnswer(raw) ? raw : { ok: false, reason: 'malformed' }
    } catch (error) {
      console.error('The account’s desktops could not be asked for:', error)
      answer = { ok: false, reason: 'failed' }
    } finally {
      asking = false
    }
    // Asked again on a clock: an unchanged answer is no change, so readers keep the same fleet.
    const key = JSON.stringify(answer)
    if (key === accountKey) return
    accountKey = key
    set({ account: answer })
  }

  const askLocal = async (): Promise<void> => {
    const { listWorkspaces, machineName } = api()
    const [list, name] = await Promise.all([
      listWorkspaces ? listWorkspaces().then((value) => value, () => null) : Promise.resolve(null),
      machineName ? machineName().then((value) => value, () => null) : Promise.resolve(null)
    ])
    set({ list: list ?? state.list, listFailed: list === null && state.list === null, name: name ?? state.name })
  }

  const refresh = (): void => {
    void askAccount()
    // Without a feed, the list is all there is of this desktop: keep it current too.
    if (state.link === 'none') void askLocal()
  }

  const wake = (): void => {
    openFeed()
    refresh()
    refreshTimer ??= setInterval(refresh, refreshMs)
  }
  const sleep = (): void => {
    closeFeed()
    if (refreshTimer !== null) clearInterval(refreshTimer)
    refreshTimer = null
  }

  const onSight = (): void => {
    if (!running) return
    if (sight?.hidden()) sleep()
    else wake()
  }

  const start = (): void => {
    if (stopTimer !== null) clearTimeout(stopTimer)
    stopTimer = null
    if (running) return
    running = true
    if (sight) unwatch = sight.watch(onSight)
    graceTimer = setTimeout(() => {
      graceTimer = null
      // Already loaded: the grace changes nothing a reader sees, so nobody is told.
      if (fleet.loading) set({ graceOver: true })
      else state = { ...state, graceOver: true }
    }, graceMs)
    void askLocal()
    if (!sight?.hidden()) wake()
  }

  const stop = (): void => {
    stopTimer = setTimeout(() => {
      stopTimer = null
      if (listeners.size > 0) return
      running = false
      sleep()
      if (graceTimer !== null) clearTimeout(graceTimer)
      graceTimer = null
      unwatch?.()
      unwatch = null
    }, stopGraceMs)
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stop()
      }
    },
    get: () => fleet
  }
}

// ── the hook ────────────────────────────────────────────────────────────────

export const documentSight: Sight = {
  hidden: () => document.visibilityState === 'hidden',
  watch: (changed) => {
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }
}

let shared: ZoomFleetStore | null = null
const fleetStore = (): ZoomFleetStore => {
  shared ??= createZoomFleetStore(() => cookrew(), { sight: documentSight })
  return shared
}
const subscribe = (listener: () => void): (() => void) => fleetStore().subscribe(listener)
const getFleet = (): ZoomFleet => fleetStore().get()

/** Every device of the owner, this one first and seated live; the same object until something changes. */
export function useZoomFleet(): ZoomFleet {
  return useSyncExternalStore(subscribe, getFleet)
}

// ── what the zoom view draws of it ──────────────────────────────────────────

/**
 * The fleet as the zoom view draws it: each machine's name and state, each
 * workspace's name, icon, counts and its agents' harness and phase. The
 * fleet itself changes on every fleet delta, a working agent's reply and
 * status line included, and the zoom view re-rendered for each (about ten
 * times a second at the full stop, profiled 2026-11-01) to draw none of it.
 */
export interface ZoomFleetView {
  machines: {
    id: string
    name: string
    local: boolean
    online: boolean
    detail: ZoomMachineDetail
    display: MachineDisplay | null
    workspaces: { id: string; name: string; icon: string | null; agents: { harness: string; phase: string }[]; counts: ZoomCounts | null; deck: { id: string; kind: 'browser' | 'note'; title: string; host: string | null }[] }[]
  }[]
}

export function fleetViewOf(fleet: ZoomFleet): ZoomFleetView {
  return {
    machines: fleet.machines.map((m) => ({
      id: m.id,
      name: m.name,
      local: m.local,
      online: m.online,
      detail: m.detail,
      display: m.display ?? null,
      workspaces: m.workspaces.map((w) => ({ id: w.id, name: w.name, icon: w.icon, agents: w.agents.map((a) => ({ harness: a.harness, phase: a.phase })), counts: w.counts, deck: deckOf(w).map((d) => ({ id: d.id, kind: d.kind, title: d.title, host: d.host ?? null })) }))
    }))
  }
}

/** The same view object until something in it changes. */
export function createFleetViewReader(read: () => ZoomFleet): () => ZoomFleetView {
  let lastFleet: ZoomFleet | null = null
  let lastView: ZoomFleetView | null = null
  let lastKey = ''
  return () => {
    const fleet = read()
    if (fleet === lastFleet && lastView) return lastView
    lastFleet = fleet
    const view = fleetViewOf(fleet)
    const key = JSON.stringify(view)
    if (lastView && key === lastKey) return lastView
    lastView = view
    lastKey = key
    return view
  }
}

const getFleetView = createFleetViewReader(getFleet)

export function useZoomFleetView(): ZoomFleetView {
  return useSyncExternalStore(subscribe, getFleetView)
}

