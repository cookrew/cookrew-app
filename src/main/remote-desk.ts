import { machineCopy } from '../shared/machine-words'
import {
  CONTROL_MS,
  NOBODY_ON_HOST,
  remoteView,
  type CardControl,
  type RemoteAccess,
  type RemoteAnswer,
  type RemoteBuild,
  type RemoteControlFacts,
  type RemoteHostView,
  type RemoteRefusal,
  type RemoteSessionRow,
  type RemoteState,
  type RemoteStateId,
  type RemoteWhere,
  type ViewerWho
} from '../shared/remote-access'
import type { RemoteGate } from './pixel-instance'
import { SERVED_USE_REFUSED } from './use-commands'

/**
 * THE ONE PLACE THAT SAYS WHERE THIS MACHINE'S SCREEN STANDS, AND WHO MAY DRIVE IT.
 *
 * The card, the sheet, the device page and the phone all read this, and every
 * way onto the screen asks it. It decides; it does not touch the machine: the
 * readers and the side effects are deps, so the whole of it runs on fakes.
 *
 * THE SECURITY MODEL, in the order it is asked:
 *
 *   THE MACHINE SWITCH. "Allow remote control of this Mac", off by default,
 *   writable only from the Mac's own window (index.ts · ownerOnly): there is
 *   no route to it. Off means nobody drives, viewer or agent.
 *
 *   THE CARD. View only by default. Take control from an owner device holds
 *   for CONTROL_MS and is then off again, by itself. It belongs to the one
 *   device that took it. Agents do not take it: they keep the rule they always
 *   had, which is the machine switch and Accessibility, and no wider.
 *
 *   THE HOST. Anyone on this machine shows here, with who and a Stop that
 *   holds the door for STOP_HOLD_MS, and every start, stop and grant is an
 *   event. Stop never shuts the Mac out of its own card.
 *
 *   SERVED WORK. A workspace a caller's session runs in is refused watching
 *   and driving, and a grant dies the moment a workspace turns served.
 *
 * Remote unlock is not here, on purpose: a locked Mac needs someone there.
 */

export interface RemoteSession {
  /** Locked, or another user on the console: either way, nothing here is ours to read. */
  readonly locked: boolean
  readonly displayAsleep: boolean
  /** A process started NOW asked about Screen Recording; null when it could not say. */
  readonly grant: boolean | null
}

export type SettingsPane = 'screen' | 'accessibility'

/** What outlives a restart. */
export interface RemoteSettings {
  readonly on: boolean
  /** Someone away from the Mac asked to hear when this pane's grant is done. */
  readonly waiting: SettingsPane | null
}

export interface RemoteDeskDeps {
  readonly platform: string
  build(): RemoteBuild
  /** Why this Linux session cannot share its screen; null when it can. */
  linuxRefusal(): string | null
  /** This process's own answer, which macOS fixes at launch. */
  screenAccess(): string
  accessibility(): boolean
  session(): Promise<RemoteSession>
  settings: { read(): RemoteSettings; write(next: RemoteSettings): void }
  servedWorkspace(workspaceId: string): boolean
  workspaceOfCard(card: string): string | null
  cardName(card: string): string
  record(type: string, card: string, name: string, details?: string): void
  keepAwake: { start(): void; stop(): void }
  /** The banner and the tray. */
  host(view: RemoteHostView): void
  /** A card's viewers should hear its status again. */
  refreshCards(): void
  /** Close the viewers of these cards that are not at the Mac. */
  dropViewers(cards: readonly string[]): void
  openSettings(pane: SettingsPane): Promise<void>
  relaunch(): void
  now?: () => number
  schedule?: (fn: () => void, ms: number) => () => void
}

/** How long Stop keeps viewers out: long enough to mean it, not so long a lost phone strands its owner. */
export const STOP_HOLD_MS = 10 * 60_000
/** A viewer whose line dropped may redial this long and still hold control. */
export const CONTROL_GRACE_MS = 30_000
/** How often a wait looks: each look is a process, and the wait can last all day. */
export const READY_WATCH_MS = 30_000
/** An agent that has not acted for this long has left the screen. */
export const AGENT_QUIET_MS = 20_000

const MACHINE = 'machine'
const WATCHING_VERBS = new Set(['screenshot', 'status', 'snapshot'])

const refuse = (error: string, state?: RemoteState): RemoteRefusal => (state ? { ok: false, error, state } : { ok: false, error })

interface Grant {
  readonly who: ViewerWho
  readonly until: number
  readonly expire: () => void
  grace: (() => void) | null
}

interface Viewer {
  readonly card: string
  readonly who: ViewerWho
  readonly since: number
}

interface AgentRow {
  readonly card: string
  readonly name: string
  readonly since: number
  mode: RemoteSessionRow['mode']
  quiet: () => void
}

export interface RemoteDesk {
  start(): void
  state(where: RemoteWhere): Promise<RemoteState>
  access(where: RemoteWhere): Promise<RemoteAccess>
  /** What a device asks before each frame: the state in the way, or null. */
  blocked(options?: { afterFailure?: boolean }): Promise<RemoteState | null>
  controlFacts(): RemoteControlFacts
  /** Why nothing may drive this machine right now: what an agent's hand is refused with. */
  inputRefusal(): string | null
  mayDrive(card: string, who: ViewerWho): boolean
  cardControl(card: string, who: ViewerWho): CardControl
  takeControl(card: string, who: ViewerWho): Promise<RemoteAnswer>
  endControl(card: string, who: ViewerWho): void
  setSwitch(on: boolean): RemoteAnswer
  /** Why this viewer may not watch this card, and the state to leave it with; null when it may. */
  admit(card: string, who: ViewerWho): { readonly message: string; readonly state: RemoteState } | null
  /** A viewer arrived; the answer is its leaving. */
  enter(card: string, viewerId: string, who: ViewerWho): () => void
  noteAgent(card: string, agent: string, verb: string): void
  hostView(): RemoteHostView
  stopAll(): void
  openSettings(pane: SettingsPane, where: RemoteWhere): Promise<void>
  restart(who: ViewerWho): RemoteAnswer
  /** The lock or the display just changed. */
  sessionChanged(): void
}

/** The desk bound to one card: what that card's device holds, and all it can reach. */
export function remoteGate(desk: RemoteDesk, card: string): RemoteGate {
  return {
    blocked: (options) => desk.blocked(options),
    inputRefusal: () => desk.inputRefusal(),
    mayDrive: (who) => desk.mayDrive(card, who),
    cardControl: (who) => desk.cardControl(card, who),
    admit: (who) => desk.admit(card, who),
    enter: (viewerId, who) => desk.enter(card, viewerId, who)
  }
}

export function createRemoteDesk(deps: RemoteDeskDeps): RemoteDesk {
  const now = deps.now ?? Date.now
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number): (() => void) => {
      const timer = setTimeout(fn, ms)
      timer.unref?.()
      return () => clearTimeout(timer)
    })
  const mac = deps.platform === 'darwin'
  const shareable = mac || deps.platform === 'linux'
  const word = (sentence: string): string => machineCopy(sentence, deps.platform)
  const grants = new Map<string, Grant>()
  const viewers = new Map<string, Viewer>()
  const agents = new Map<string, AgentRow>()
  let settings = readSettings()
  let holdUntil = 0
  let awake = false
  let cancelWatch: (() => void) | null = null
  let told: RemoteStateId | null = null

  function readSettings(): RemoteSettings {
    try {
      return deps.settings.read()
    } catch {
      // An unreadable file is the default, and the default is off.
      return { on: false, waiting: null }
    }
  }

  const held = (): boolean => holdUntil > now()
  const stateOf = (id: RemoteStateId, more: Partial<RemoteState> = {}): RemoteState => ({
    id,
    platform: mac ? 'darwin' : 'linux',
    build: deps.build(),
    then: null,
    detail: null,
    lastSeenAt: null,
    until: null,
    waiting: settings.waiting !== null,
    ...more
  })

  const permission = (session: RemoteSession, afterFailure: boolean): RemoteStateId | null => {
    if (!mac) return null
    if (deps.screenAccess() !== 'granted') return session.grant === true ? 'needs-restart' : 'needs-screen-recording'
    return afterFailure && session.grant === false ? 'needs-screen-recording' : null
  }

  const machineState = async (afterFailure = false): Promise<RemoteState> => {
    if (!shareable) return stateOf('unsupported')
    const refusal = mac ? null : deps.linuxRefusal()
    if (refusal) return stateOf('unsupported', { detail: refusal })
    const session = await deps.session()
    const missing = permission(session, afterFailure)
    if (session.locked) return stateOf('locked', { then: missing })
    if (missing) return stateOf(missing)
    return stateOf(session.displayAsleep ? 'display-asleep' : 'ready')
  }

  const state = async (where: RemoteWhere): Promise<RemoteState> =>
    where === 'away' && held() ? stateOf('stopped', { until: holdUntil }) : machineState()

  const controlFacts = (): RemoteControlFacts => ({ available: mac, switchOn: mac && settings.on, accessibility: mac && deps.accessibility() })

  const switchOff = (): string => word('Remote control of this Mac is off. Someone at the Mac can turn it on in the ⋯ menu.')
  const stopped = (): string => word('Stopped at the Mac: someone there ended this session.')
  const accessibilityOff = (): string => `Accessibility is off for ${deps.build().settingsName}: turn it on in System Settings › Privacy & Security › Accessibility.`

  const inputRefusal = (): string | null => {
    if (held()) return stopped()
    if (!settings.on) return switchOff()
    return deps.accessibility() ? null : accessibilityOff()
  }

  const servedCard = (card: string): boolean => {
    const workspace = deps.workspaceOfCard(card)
    return workspace !== null && deps.servedWorkspace(workspace)
  }

  const liveGrant = (card: string): Grant | null => {
    const grant = grants.get(card)
    return grant && grant.until > now() ? grant : null
  }

  // MARK: the host

  const rows = (): RemoteSessionRow[] => {
    const byDevice = new Map<string, RemoteSessionRow>()
    for (const viewer of viewers.values()) {
      if (viewer.who.here) continue
      const key = `${viewer.who.key}|${viewer.card}`
      const seen = byDevice.get(key)
      const mode = liveGrant(viewer.card)?.who.key === viewer.who.key ? 'controlling' : 'watching'
      byDevice.set(key, { key, who: viewer.who.name, card: viewer.card, cardName: deps.cardName(viewer.card), mode, since: Math.min(seen?.since ?? viewer.since, viewer.since) })
    }
    const people = [...byDevice.values()]
    const working = [...agents.entries()].map(([key, agent]): RemoteSessionRow => ({ key, who: agent.name, card: agent.card, cardName: deps.cardName(agent.card), mode: agent.mode, since: agent.since }))
    return [...people, ...working].sort((a, b) => a.since - b.since)
  }

  const hostView = (): RemoteHostView => {
    const list = rows()
    return list.length === 0 && !awake ? NOBODY_ON_HOST : { rows: list, awake }
  }

  const syncHost = (): void => {
    const watched = [...viewers.values()].some((viewer) => !viewer.who.here)
    if (watched !== awake) {
      awake = watched
      if (watched) deps.keepAwake.start()
      else deps.keepAwake.stop()
    }
    deps.host(hostView())
  }

  const ended = (card: string, why: string): void => {
    const grant = grants.get(card)
    if (!grant) return
    grant.expire()
    grant.grace?.()
    grants.delete(card)
    deps.record('remote.control-off', card, deps.cardName(card), `${grant.who.name} · ${why}`)
    deps.refreshCards()
    syncHost()
  }

  const endAllGrants = (why: string): void => {
    for (const card of [...grants.keys()]) ended(card, why)
  }

  // MARK: control

  const standing = (card: string, who: ViewerWho): RemoteRefusal | null => {
    if (!mac) return refuse(word('Driving this Mac is not available here: the screen is view only.'))
    if (servedCard(card)) return refuse(SERVED_USE_REFUSED)
    if (!settings.on) return refuse(switchOff())
    if (held() && !who.here) return refuse(stopped())
    const holder = liveGrant(card)
    return holder && holder.who.key !== who.key ? refuse(`${holder.who.name} has control of this card.`) : null
  }

  const grant = (card: string, who: ViewerWho): void => {
    grants.get(card)?.expire()
    grants.get(card)?.grace?.()
    const expire = schedule(() => ended(card, 'the 15 minutes ended'), CONTROL_MS)
    grants.set(card, { who, until: now() + CONTROL_MS, expire, grace: null })
    deps.record('remote.control-on', card, deps.cardName(card), `${who.name} · 15 minutes`)
    deps.refreshCards()
    syncHost()
  }

  // MARK: waiting for a grant

  const writeWaiting = (waiting: SettingsPane | null): void => {
    settings = { ...settings, waiting }
    try {
      deps.settings.write(settings)
    } catch {
      // The wait stands for this run; only a restart would lose it.
    }
  }

  const finishWait = (pane: SettingsPane): void => {
    writeWaiting(null)
    told = null
    deps.record('remote.ready', MACHINE, word('this Mac'), pane === 'screen' ? 'Screen Recording is on and the screen can be seen' : 'Accessibility is on')
  }

  const checkWait = async (): Promise<void> => {
    const pane = settings.waiting
    if (pane === null) return
    const read = await machineState().catch(() => null)
    if (read === null) return watch(READY_WATCH_MS)
    if (pane === 'accessibility' ? deps.accessibility() : read.id === 'ready') return finishWait(pane)
    if (read.id === 'needs-restart' && told !== 'needs-restart') {
      told = 'needs-restart'
      deps.record('remote.restart-needed', MACHINE, word('this Mac'), 'Screen Recording is on; Cookrew needs a restart to finish')
    }
    watch(READY_WATCH_MS)
  }

  function watch(ms: number): void {
    cancelWatch?.()
    cancelWatch = schedule(() => {
      cancelWatch = null
      void checkWait()
    }, ms)
  }

  return {
    start() {
      // A file can be edited while the app is down, so a launch with the switch on leaves a line.
      if (settings.on) deps.record('remote.switch-on', MACHINE, word('this Mac'), 'found on at launch')
      if (settings.waiting !== null) watch(0)
    },
    state,
    access: async (where) => ({ state: await state(where), control: controlFacts() }),
    blocked: async (options = {}) => {
      const read = await machineState(options.afterFailure === true)
      return read.id === 'ready' ? null : read
    },
    controlFacts,
    inputRefusal,
    mayDrive(card, who) {
      if (!mac || !settings.on || servedCard(card)) return false
      if (held() && !who.here) return false
      return liveGrant(card)?.who.key === who.key
    },
    cardControl(card, who) {
      const holder = liveGrant(card)
      const mine = holder?.who.key === who.key
      return { switchOn: mac && settings.on, until: mine ? (holder?.until ?? null) : null, heldBy: holder && !mine ? holder.who.name : null, awake, machine: mac ? 'darwin' : 'linux' }
    },
    async takeControl(card, who) {
      const before = standing(card, who)
      if (before) return before
      const read = await machineState()
      if (read.id !== 'ready') return refuse(remoteView(read, who.here ? 'here' : 'away').sentence, read)
      if (!deps.accessibility()) return refuse(accessibilityOff(), stateOf('needs-accessibility'))
      // A wait is when this changes: the switch may have gone off behind the read.
      const after = standing(card, who)
      if (after) return after
      grant(card, who)
      return { ok: true }
    },
    endControl(card, who) {
      const holder = grants.get(card)
      if (holder && (holder.who.key === who.key || who.here)) ended(card, `ended by ${who.name}`)
    },
    setSwitch(on) {
      if (on === settings.on) return { ok: true }
      try {
        deps.settings.write({ ...settings, on })
      } catch (error) {
        return refuse(error instanceof Error ? error.message : String(error))
      }
      settings = { ...settings, on }
      if (!on) endAllGrants('remote control was turned off at the Mac')
      deps.record(on ? 'remote.switch-on' : 'remote.switch-off', MACHINE, word('this Mac'), 'at the Mac')
      deps.refreshCards()
      return { ok: true }
    },
    admit(card, who) {
      if (who.here) return null
      if (servedCard(card)) return { message: SERVED_USE_REFUSED, state: stateOf('unsupported', { detail: SERVED_USE_REFUSED }) }
      return held() ? { message: stopped(), state: stateOf('stopped', { until: holdUntil }) } : null
    },
    enter(card, viewerId, who) {
      const since = now()
      viewers.set(viewerId, { card, who, since })
      const holder = grants.get(card)
      if (holder?.who.key === who.key) {
        holder.grace?.()
        holder.grace = null
      }
      if (!who.here) deps.record('remote.view-started', card, deps.cardName(card), who.name)
      syncHost()
      return () => {
        if (!viewers.delete(viewerId)) return
        if (!who.here) deps.record('remote.view-ended', card, deps.cardName(card), `${who.name} · ${Math.max(1, Math.round((now() - since) / 60_000))} min`)
        const left = ![...viewers.values()].some((viewer) => viewer.card === card && viewer.who.key === who.key)
        const mine = grants.get(card)
        if (left && mine?.who.key === who.key) mine.grace = schedule(() => ended(card, `${who.name} left`), CONTROL_GRACE_MS)
        syncHost()
      }
    },
    noteAgent(card, agent, verb) {
      const key = `agent|${agent}|${card}`
      const mode = WATCHING_VERBS.has(verb) ? 'watching' : 'controlling'
      const known = agents.get(key)
      known?.quiet()
      const quiet = schedule(() => {
        agents.delete(key)
        deps.record('remote.agent-ended', card, deps.cardName(card), agent)
        syncHost()
      }, AGENT_QUIET_MS)
      if (known) {
        known.quiet = quiet
        if (known.mode === mode) return
        known.mode = mode
      } else {
        agents.set(key, { card, name: agent, since: now(), mode, quiet })
        deps.record('remote.agent-started', card, deps.cardName(card), `${agent} · ${verb}`)
      }
      syncHost()
    },
    hostView,
    stopAll() {
      holdUntil = now() + STOP_HOLD_MS
      schedule(() => deps.refreshCards(), STOP_HOLD_MS)
      endAllGrants('stopped at the Mac')
      const watched = new Set([...viewers.values()].filter((viewer) => !viewer.who.here).map((viewer) => viewer.card))
      deps.record('remote.stopped', MACHINE, word('this Mac'), `${watched.size} card${watched.size === 1 ? '' : 's'} · at the Mac`)
      deps.dropViewers([...watched])
      deps.refreshCards()
      syncHost()
    },
    async openSettings(pane, where) {
      if (where === 'away') {
        writeWaiting(pane)
        watch(READY_WATCH_MS)
      }
      await deps.openSettings(pane)
    },
    restart(who) {
      if (deps.build().restart !== 'self') return refuse('This build cannot restart itself: start it again from its terminal.')
      deps.record('remote.restart', MACHINE, word('this Mac'), who.name)
      deps.relaunch()
      return { ok: true }
    },
    sessionChanged() {
      deps.refreshCards()
      if (settings.waiting !== null) watch(0)
    }
  }
}
