import { cleanAgentName } from './agent-name'

/**
 * WHAT THE PICKER SHOWS, AND WHAT A TAP SENDS BACK.
 *
 * The sheet lists this machine's windows and displays. A tap names a source
 * by its id, never by an address: main looks the id up in its own list and
 * writes the address itself, so a client cannot hand a card an address it
 * made up. A window's id is the window, for as long as the window lives.
 */

export type UseSourceKind = 'window' | 'screen'

export interface UseSource {
  /** `window:<id>`, `screen:main`, `screen:<n>`. */
  readonly id: string
  readonly kind: UseSourceKind
  readonly title: string
  /** The app a window belongs to; null for a display. */
  readonly app: string | null
  /** The card address this source makes. */
  readonly address: string
  /** A data: URL, or null when no picture could be taken. */
  readonly thumb: string | null
  readonly icon: string | null
  readonly width: number
  readonly height: number
}

export interface UseSourceList {
  /** `needs-permission` and `unavailable` carry a sentence instead of rows. */
  readonly state: 'ready' | 'needs-permission' | 'unavailable'
  readonly windows: readonly UseSource[]
  readonly screens: readonly UseSource[]
  readonly message: string | null
  /** The grant that is missing, by the name System Settings gives it. */
  readonly permission: 'Screen Recording' | null
  /** Why the Windows tab is empty on purpose (Linux). */
  readonly windowsNote: string | null
}

export interface UseSourcePick {
  readonly source: string
  /** Point this use card at the source instead of making a new one. */
  readonly card?: string
}

export interface UseSourceCard {
  readonly id: string
  readonly name: string
  readonly url: string
}

export type UseSourceOpened = { readonly ok: true; readonly card: UseSourceCard } | { readonly ok: false; readonly error: string }

export type UseSourceSettings = { readonly ok: true } | { readonly ok: false; readonly error: string }

export const USE_SOURCES_PATH = '/api/use/sources'

/** The sheet's own question to main on a machine that has nothing to list. */
export const emptySourceList = (state: 'needs-permission' | 'unavailable', message: string): UseSourceList => ({
  state,
  windows: [],
  screens: [],
  message,
  permission: null,
  windowsNote: null
})

/** A machine that can share: its rows, and why its Windows tab is empty if it is. */
export const readySourceList = (rows: Pick<UseSourceList, 'windows' | 'screens'> & { readonly windowsNote?: string }): UseSourceList => ({
  state: 'ready',
  windows: rows.windows,
  screens: rows.screens,
  message: null,
  permission: null,
  windowsNote: rows.windowsNote ?? null
})

const SOURCE_ID = /^(?:window:[1-9][0-9]{0,9}|screen:(?:main|[1-9][0-9]?))$/

export const isUseSourceId = (value: unknown): value is string => typeof value === 'string' && SOURCE_ID.test(value)

/** The name a card made from this source wears: what a rename would make of it, since a title is whatever the app says. */
export function cardNameOf(source: Pick<UseSource, 'title' | 'app'>): string {
  const name = source.app && source.app !== source.title ? `${source.app} — ${source.title}` : source.title
  return cleanAgentName(name) || 'Window'
}
