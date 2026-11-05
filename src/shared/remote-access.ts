import { machineCopy } from './machine-words'

/**
 * WHERE A MACHINE'S SCREEN STANDS, AND WHAT TO DO NEXT.
 *
 * One model, read by the card, the picker's sheet, the device page and the
 * phone alike. Main decides the state (main/remote-desk.ts); this says it. A
 * state is one sentence and the next action, never a bare "offline".
 *
 * WHERE THE READER IS CHANGES THE WORDS, NOT THE STATE. System Settings only
 * helps someone at the Mac, so away from it a jump says plainly that it needs
 * them there and is offered as what it really is: opening it for later.
 *
 * THE NAME IS THE ONE THE READER WILL SEE. A source build is listed in System
 * Settings as Electron, not Cookrew, so `settingsName` comes from the running
 * build and a sentence never promises a row that is not there.
 */

export type RemoteStateId =
  | 'ready'
  | 'locked'
  | 'needs-screen-recording'
  | 'needs-restart'
  | 'needs-accessibility'
  | 'display-asleep'
  | 'unreachable'
  | 'window-closed'
  | 'unsupported'
  | 'stopped'

export type RemoteWhere = 'here' | 'away'

export interface RemoteBuild {
  /** What System Settings lists this build as. */
  readonly settingsName: string
  readonly sourceBuild: boolean
  /** `self`: it can relaunch itself. `by-hand`: someone has to start it again. */
  readonly restart: 'self' | 'by-hand'
  /** What a restart does to agents: proved per host in tests/restart-keeps-agents.integration.test.ts. */
  readonly agents: 'keep' | 'keep-not-served' | 'stop'
}

export interface RemoteState {
  readonly id: RemoteStateId
  readonly platform: 'darwin' | 'linux'
  readonly build: RemoteBuild
  /** What will stand in the way after this: a lock hides a permission that is off. */
  readonly then: RemoteStateId | null
  /** The sentence of a state only its source can word: an unsupported session, a closed window. */
  readonly detail: string | null
  /** When a real frame last arrived. */
  readonly lastSeenAt: number | null
  /** When a session stopped at the Mac can be opened again. */
  readonly until: number | null
  /** Someone away asked to be told when this clears. */
  readonly waiting: boolean
}

export type RemoteActionId = 'open-screen-settings' | 'open-accessibility-settings' | 'check-again' | 'restart' | 'show-the-screen' | 'pick-another'

export interface RemoteConfirm {
  readonly title: string
  readonly sentence: string
  readonly yes: string
}

export interface RemoteAction {
  readonly id: RemoteActionId
  readonly label: string
  readonly confirm?: RemoteConfirm
}

export interface RemoteView {
  readonly title: string
  readonly sentence: string
  /** The state after this one, in a line. */
  readonly next: string | null
  readonly actions: readonly RemoteAction[]
  /** Nothing can be done from a screen somewhere else. */
  readonly needsYouThere: boolean
  readonly note: string | null
}

/** Who is watching or driving, as far as a credential can say. */
export interface ViewerWho {
  /** One per device: `mac`, `root`, `device:<id>`. */
  readonly key: string
  readonly name: string
  /** The Mac's own window: at the machine, so not a remote session. */
  readonly here: boolean
}

export const MAC_VIEWER: ViewerWho = { key: 'mac', name: 'This Mac', here: true }

/** What a viewer of one card may do, in that viewer's own terms. */
export interface CardControl {
  /** The machine switch: off means nobody takes control, from anywhere. */
  readonly switchOn: boolean
  /** This viewer holds control until then. */
  readonly until: number | null
  /** Another device holds it. */
  readonly heldBy: string | null
  /** The Mac is held awake because someone is watching. */
  readonly awake: boolean
}

export interface RemoteControlFacts {
  /** False where nothing can drive this machine at all (Linux). */
  readonly available: boolean
  readonly switchOn: boolean
  readonly accessibility: boolean
}

export interface RemoteAccess {
  readonly state: RemoteState
  readonly control: RemoteControlFacts
}

export interface RemoteSessionRow {
  readonly key: string
  readonly who: string
  readonly card: string
  readonly cardName: string
  readonly mode: 'watching' | 'controlling'
  readonly since: number
}

/** What the host shows while anyone is on this machine. */
export interface RemoteHostView {
  readonly rows: readonly RemoteSessionRow[]
  readonly awake: boolean
}

export const NOBODY_ON_HOST: RemoteHostView = { rows: [], awake: false }

export type RemoteRefusal = { readonly ok: false; readonly error: string; readonly state?: RemoteState }
export type RemoteAnswer = { readonly ok: true } | RemoteRefusal

/** How long Take control lasts; then it is off again. */
export const CONTROL_MS = 15 * 60_000

const SCREEN_PANE = 'System Settings › Privacy & Security › Screen & System Audio Recording'
const ACCESSIBILITY_PANE = 'System Settings › Privacy & Security › Accessibility'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function lastSeenWords(at: number | null, now: number): string {
  if (at === null) return 'not seen yet from here'
  const ago = Math.max(0, now - at)
  if (ago < MINUTE) return 'last seen just now'
  if (ago < HOUR) return `last seen ${Math.round(ago / MINUTE)} min ago`
  if (ago < 2 * DAY) return `last seen ${Math.round(ago / HOUR)} h ago`
  return `last seen ${Math.round(ago / DAY)} days ago`
}

const buildName = (build: RemoteBuild): string => (build.sourceBuild ? 'this source build' : 'Cookrew')

const AGENTS_STAY = 'Agents keep running: their terminals live outside Cookrew and reconnect when it is back. Asks in flight are cut off and marked interrupted.'

function agentsLine(build: RemoteBuild): string {
  if (build.agents === 'stop') return 'This build runs agents inside Cookrew, so restarting stops them.'
  if (build.agents === 'keep-not-served') return `${AGENTS_STAY} Served sessions run inside Cookrew, so they end.`
  return AGENTS_STAY
}

export function restartConfirm(build: RemoteBuild, where: RemoteWhere): RemoteConfirm {
  const away = where === 'away' ? ' You lose this view for about a minute.' : ''
  return { title: 'Restart Cookrew?', sentence: `${agentsLine(build)}${away}`, yes: 'Restart Cookrew' }
}

const CHECK: RemoteAction = { id: 'check-again', label: 'Check again' }

const settingsJump = (id: RemoteActionId, where: RemoteWhere): RemoteAction => ({
  id,
  label: where === 'here' ? 'Open System Settings' : 'Open it on the Mac for later'
})

const NEXT: Partial<Record<RemoteStateId, string>> = {
  'needs-screen-recording': 'After that, Screen Recording is off too.',
  'needs-restart': 'After that, Cookrew needs a restart to finish turning on Screen Recording.'
}

function permissionView(state: RemoteState, where: RemoteWhere, title: string, jump: RemoteActionId, sentence: string): Omit<RemoteView, 'next'> {
  const away = where === 'away'
  return {
    title,
    sentence: away ? `This needs you at the Mac: ${sentence.charAt(0).toLowerCase()}${sentence.slice(1)}` : sentence,
    actions: [settingsJump(jump, where), CHECK],
    needsYouThere: away,
    note: state.waiting ? 'System Settings is open on the Mac. Cookrew will tell you here when it is ready.' : null
  }
}

function restartView(state: RemoteState, where: RemoteWhere): Omit<RemoteView, 'next'> {
  const name = buildName(state.build)
  const title = 'Restart to finish'
  if (state.build.restart === 'self') {
    const restart: RemoteAction = { id: 'restart', label: 'Restart Cookrew', confirm: restartConfirm(state.build, where) }
    return { title, sentence: `Screen Recording is on, and macOS applies it when ${name} next starts.`, actions: [restart, CHECK], needsYouThere: false, note: null }
  }
  const byHand = `Screen Recording is on, but ${name} cannot restart itself: stop it in its terminal and run npm run dev again.`
  return where === 'away'
    ? { title, sentence: `This needs you at the Mac: ${byHand.charAt(0).toLowerCase()}${byHand.slice(1)}`, actions: [CHECK], needsYouThere: true, note: null }
    : { title, sentence: byHand, actions: [CHECK], needsYouThere: false, note: null }
}

function stateView(state: RemoteState, where: RemoteWhere, now: number): Omit<RemoteView, 'next'> {
  const seen = lastSeenWords(state.lastSeenAt, now)
  const plain = (title: string, sentence: string, needsYouThere = false, actions: readonly RemoteAction[] = [CHECK]): Omit<RemoteView, 'next'> => ({
    title,
    sentence,
    actions,
    needsYouThere,
    note: null
  })
  const { settingsName: name } = state.build
  switch (state.id) {
    case 'ready':
      return plain('Ready', 'The screen of this Mac can be shared.', false, [])
    case 'locked':
      return plain('This Mac is locked', `It needs someone at the Mac to unlock it, and the picture comes back by itself (${seen}).`, true)
    case 'needs-screen-recording':
      return permissionView(state, where, 'Screen Recording is off', 'open-screen-settings', `Turn on ${name} in ${SCREEN_PANE}.`)
    case 'needs-accessibility':
      return permissionView(state, where, 'Accessibility is off', 'open-accessibility-settings', `Turn on ${name} in ${ACCESSIBILITY_PANE} to control this Mac.`)
    case 'needs-restart':
      return restartView(state, where)
    case 'display-asleep':
      return plain('The display is asleep', `Nothing can be seen until it wakes (${seen}).`)
    case 'unreachable':
      return plain('Cannot reach this Mac', `It may be asleep or off the network (${seen}).`)
    case 'window-closed':
      return plain('The window closed', state.detail ?? 'The window this card showed has closed.', false, [
        { id: 'show-the-screen', label: 'Show the screen' },
        { id: 'pick-another', label: 'Pick another window' }
      ])
    case 'unsupported':
      return plain('Cannot share this screen', state.detail ?? 'This machine has no way to share its screen yet.', false, [])
    case 'stopped': {
      const minutes = state.until === null ? 0 : Math.max(1, Math.round((state.until - now) / MINUTE))
      return plain('Stopped at the Mac', `Someone at the Mac ended this session; it can be opened again in ${minutes} min.`, true, [])
    }
  }
}

/** The state as this reader should read it. `now` is for tests; a view is drawn at the time it is drawn. */
export function remoteView(state: RemoteState, where: RemoteWhere, now: number = Date.now()): RemoteView {
  const view = stateView(state, where, now)
  const word = (sentence: string): string => machineCopy(sentence, state.platform)
  const next = state.then ? (NEXT[state.then] ?? null) : null
  return {
    ...view,
    title: word(view.title),
    sentence: word(view.sentence),
    next: next === null ? null : word(next),
    note: view.note === null ? null : word(view.note)
  }
}

const IDS: readonly RemoteStateId[] = ['ready', 'locked', 'needs-screen-recording', 'needs-restart', 'needs-accessibility', 'display-asleep', 'unreachable', 'window-closed', 'unsupported', 'stopped']

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.length <= max ? value : null)
const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/** A state off the wire: the viewer draws buttons from it, so it is read, never trusted as shaped. */
export function parseRemoteState(raw: unknown): RemoteState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const s = raw as Record<string, unknown>
  const build = s.build as Record<string, unknown> | null | undefined
  if (!IDS.includes(s.id as RemoteStateId) || (s.platform !== 'darwin' && s.platform !== 'linux') || typeof build !== 'object' || build === null) return null
  const settingsName = text(build.settingsName, 64)
  if (settingsName === null) return null
  if (build.restart !== 'self' && build.restart !== 'by-hand') return null
  if (build.agents !== 'keep' && build.agents !== 'keep-not-served' && build.agents !== 'stop') return null
  return {
    id: s.id as RemoteStateId,
    platform: s.platform,
    build: { settingsName, sourceBuild: build.sourceBuild === true, restart: build.restart, agents: build.agents },
    then: IDS.includes(s.then as RemoteStateId) ? (s.then as RemoteStateId) : null,
    detail: text(s.detail, 400),
    lastSeenAt: time(s.lastSeenAt),
    until: time(s.until),
    waiting: s.waiting === true
  }
}

export function parseCardControl(raw: unknown): CardControl | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  return { switchOn: c.switchOn === true, until: time(c.until), heldBy: text(c.heldBy, 120), awake: c.awake === true }
}
