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
import { registerScopeState, scopeNeedsMachine, subscribeMachineScope } from '../machine-scope'
import { useSyncExternalStore } from 'react'
import type { FleetEvent, FleetSnapshot, MachineDisplay } from '../../../shared/fleet'
import type { AccountMachine, AccountMachines, AccountMachinesRefusal } from '../../../shared/zoom-fleet'
import { foldFleet } from '../../../shared/fleet-fold'
import { machineOutdated } from '../../../shared/machine-version'
import { cookrew, type CookrewApi } from '../api'
import { composeFleet, deckOf, snapshotOf, type FleetParts, type ZoomCounts, type ZoomFleet, type ZoomMachineDetail } from './fleet-compose'

export * from './fleet-compose'

export const LOAD_GRACE_MS = 2_500
export const STOP_GRACE_MS = 1_000
/** The registry's presence is asked again on this clock while in sight. */
export const ACCOUNT_REFRESH_MS = 60_000
export const RETRY_MS = 2_000
export const RETRY_MAX_MS = 30_000

export const REMOTE_READ_MS = 5_000

const ACCOUNT_SENTENCE: Partial<Record<AccountMachinesRefusal, string>> = {
  offline: 'Your other devices could not be listed: cookrew.dev did not answer.',
  refused: 'Your other devices could not be listed: cookrew.dev refused.',
  malformed: 'Your other devices could not be listed: cookrew.dev sent an answer this app cannot read.',
  failed: 'Your other devices could not be asked for.'
}

export const LOCAL_UNREADABLE = 'This desktop’s workspaces could not be read.'

// ── the store ───────────────────────────────────────────────────────────────

export type FleetApi = Partial<Pick<CookrewApi, 'subscribeZoomFleet' | 'zoomFleetMachines' | 'listWorkspaces' | 'machineName' | 'machineFleetOf'>>

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
  /**
   * Which of the account's other machines may be asked for their fleet. Absent
   * = every one that is online. The console passes its version floor
   * (shared/machine-version.ts): a machine too old is drawn by name and asked
   * nothing, here as on the console's own Devices level.
   */
  readable?: (row: AccountMachine) => boolean
}

export interface ZoomFleetStore {
  subscribe: (listener: () => void) => () => void
  get: () => ZoomFleet
  /**
   * The machine this page talks to is another one now (machine-scope.ts).
   * What was read through the last one is let go of (its feed, its workspace
   * list, its name, and the account's list as it answered it, which says
   * which row is "this one"), the feed is closed, and answers still on their
   * way are dropped; `resume` reads the one now in scope.
   */
  turn: () => void
  resume: () => void
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
  let remoteTimer: ReturnType<typeof setInterval> | null = null
  let remoteKey = ''
  let readingRemote = false
  let unwatch: (() => void) | null = null
  let asking = false
  /**
   * Which machine's turn this is. Every question below is put to "this
   * machine" or names which row is it; an answer that comes back after the
   * machine changed (`turn`) belongs to the last one and is dropped.
   */
  let turns = 0

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
    let opened: () => void
    try {
      opened = subscribe(
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
    } catch {
      // Nobody to ask (the console, between machines): as a surface with no feed.
      if (state.link !== 'none') set({ link: 'none' })
      return
    }
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
    const mine = turns
    asking = true
    let answer: AccountMachines
    try {
      const raw: unknown = await ask()
      answer = isAnswer(raw) ? raw : { ok: false, reason: 'malformed' }
    } catch (error) {
      if (mine === turns) console.error('The account’s desktops could not be asked for:', error)
      answer = { ok: false, reason: 'failed' }
    } finally {
      if (mine === turns) asking = false
    }
    if (mine !== turns) return
    // Asked again on a clock: an unchanged answer is no change, so readers keep the same fleet.
    const key = JSON.stringify(answer)
    if (key === accountKey) return
    accountKey = key
    set({ account: answer })
    // The machines are known now: read the ones this desktop holds a key for.
    void askRemote()
  }

  /** The account's other machines, each read through the key this desktop holds for it. */
  const askRemote = async (): Promise<void> => {
    const read = api().machineFleetOf
    const mayRead = options.readable ?? ((): boolean => true)
    const rows = state.account?.ok ? state.account.machines.filter((row) => !row.current && row.online && mayRead(row)) : []
    if (!read || readingRemote || rows.length === 0) return
    const mine = turns
    readingRemote = true
    try {
      const answers = await Promise.all(rows.map(async (row) => [row.id, snapshotOf(await read(row.id).catch(() => null))] as const))
      // Read through the last machine's keys, of the rows that were "the others" then.
      if (mine !== turns) return
      const remote = Object.fromEntries(answers.filter((pair): pair is readonly [string, FleetSnapshot] => pair[1] !== null))
      const key = JSON.stringify(remote)
      if (key === remoteKey) return
      remoteKey = key
      set({ remote })
    } finally {
      if (mine === turns) readingRemote = false
    }
  }

  const askLocal = async (): Promise<void> => {
    const { listWorkspaces, machineName } = api()
    const mine = turns
    // An api that refuses to be asked at all (nobody in scope) is no answer, like one that fails.
    const asked = <T,>(ask: (() => Promise<T>) | undefined): Promise<T | null> => {
      try {
        return ask ? ask().then((value) => value, () => null) : Promise.resolve(null)
      } catch {
        return Promise.resolve(null)
      }
    }
    const [list, name] = await Promise.all([asked(listWorkspaces), asked(machineName)])
    if (mine !== turns) return
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
    void askRemote()
    remoteTimer ??= setInterval(() => void askRemote(), REMOTE_READ_MS)
  }
  const sleep = (): void => {
    closeFeed()
    if (refreshTimer !== null) clearInterval(refreshTimer)
    refreshTimer = null
    if (remoteTimer !== null) clearInterval(remoteTimer)
    remoteTimer = null
  }

  const onSight = (): void => {
    if (!running) return
    if (sight?.hidden()) sleep()
    else wake()
  }

  /** How long a machine may take to say anything before the view stops saying it is loading. */
  const startGrace = (): void => {
    if (graceTimer !== null) clearTimeout(graceTimer)
    graceTimer = setTimeout(() => {
      graceTimer = null
      // Already loaded: the grace changes nothing a reader sees, so nobody is told.
      if (fleet.loading) set({ graceOver: true })
      else state = { ...state, graceOver: true }
    }, graceMs)
  }

  const start = (): void => {
    if (stopTimer !== null) clearTimeout(stopTimer)
    stopTimer = null
    if (running) return
    running = true
    if (sight) unwatch = sight.watch(onSight)
    startGrace()
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
    get: () => fleet,
    turn: () => {
      closeFeed()
      retries = 0
      // Questions still out were put to the last machine: their answers are dropped, and the next may ask at once.
      turns += 1
      asking = false
      readingRemote = false
      // The account is asked again, and its last answer let go of: it says
      // which row is "this one", and kept, the next machine's own feed would
      // be drawn under the last machine's id until the next answer.
      accountKey = ''
      remoteKey = ''
      // Loading again, for a grace of its own, which ends whether or not anything is read next
      // (with no machine in scope nothing is, and "loading" must still end).
      state = { ...state, graceOver: false }
      if (running) startGrace()
      else if (graceTimer !== null) {
        clearTimeout(graceTimer)
        graceTimer = null
      }
      set({ snapshot: null, link: 'connecting', list: null, name: null, listFailed: false, account: null, remote: undefined })
    },
    resume: () => {
      if (!running) return
      void askLocal()
      if (!sight?.hidden()) {
        openFeed()
        refresh()
      }
    }
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
// Let go of while the old machine is in scope; read again once the new one
// is. It closes a feed and tells its readers, so it goes with what stops.
registerScopeState('zoom fleet', () => shared?.turn(), 'stop')
// On the console with no machine in scope there is no "this machine" to read.
subscribeMachineScope((scope) => {
  if (!scopeNeedsMachine(scope) || scope.machineId !== null) shared?.resume()
})
/** The page's one fleet store, made when somebody first reads it. */
export const sharedZoomFleet = (): ZoomFleetStore => {
  // On the console, a machine below the floor is asked nothing (shared/machine-version.ts).
  shared ??= createZoomFleetStore(() => cookrew(), { sight: documentSight, readable: (row) => !scopeNeedsMachine() || !machineOutdated(row.appVersion) })
  return shared
}
const subscribe = (listener: () => void): (() => void) => sharedZoomFleet().subscribe(listener)
const getFleet = (): ZoomFleet => sharedZoomFleet().get()

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
    /** The build it runs: what the console's floor is judged by on the devices stop (machine-why.ts). */
    appVersion: string | null
    /** False when the registry says nobody is signed in on it (machine-why.ts says what to do then). */
    signedIn?: boolean
    os: string | null
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
      appVersion: m.appVersion,
      ...(m.signedIn === undefined ? {} : { signedIn: m.signedIn }),
      os: m.profile?.os ?? null,
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

