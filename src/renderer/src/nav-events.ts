/**
 * HOW PEOPLE MOVE THROUGH THE VIEWS, COUNTED ON THIS MACHINE (owner, 2026-11-17).
 *
 * First the full views: where an agent's or an artifact's full view is opened
 * from, where back takes it, by which key, and how often it is left some other
 * way. Every field is a closed set, so no id, name, title, path or text can ride
 * along: the type says so and `readNavEvent` refuses anything else.
 *
 * NOTHING LEAVES THE MACHINE. The only data that does is the onboarding funnel
 * (shared/funnel-events.ts), whose allowlist is a privacy ruling; sending these
 * would be a change to it, not to this file. Here they are counts per UTC day in
 * the page's storage (KEEP_DAYS days), the last RECENT in memory, and each one
 * announced as a `cookrew:nav` window event for whatever reads them next.
 *
 * Silent: tracking never throws and never waits.
 */
import type { FullKind, PlaceKind } from './zoom/full-return'

export const NAV_PLACES = ['devices', 'workspaces', 'agents', 'card', 'artifacts', 'agent-full', 'item-full'] as const satisfies readonly PlaceKind[]
/** What took the person back: the bar's ‹, Esc, the phone's or browser's back, a click on the background, the phone bar's ‹, the page's own close. */
export const BACK_INPUTS = ['button', 'esc', 'system', 'background', 'route', 'pane'] as const
export type BackInput = (typeof BACK_INPUTS)[number]
const FULL_KINDS = ['agent', 'item'] as const satisfies readonly FullKind[]
/** Every place is listed: one added to PlaceKind and not here would have its events refused without a word. */
export const NAV_PLACES_COMPLETE: [Exclude<PlaceKind, (typeof NAV_PLACES)[number]>] extends [never] ? true : false = true

export type NavEvent =
  /** A full view opened, from where the view stood. */
  | { readonly name: 'full_open'; readonly kind: FullKind; readonly from: PlaceKind }
  /** Back from a full view: to the page it was opened from (previous), or one stop out. */
  | { readonly name: 'full_back'; readonly kind: FullKind; readonly to: PlaceKind; readonly by: BackInput; readonly previous: boolean }
  /** A full view left by a stop or a crumb rather than back. */
  | { readonly name: 'full_leave'; readonly kind: FullKind; readonly to: PlaceKind }

export const NAV_STORAGE_KEY = 'cookrew.nav-counts'
export const NAV_DOM_EVENT = 'cookrew:nav'
export const KEEP_DAYS = 30
export const RECENT = 50

const has = <T extends string>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value)

/** An event, or null: an unknown name, a field outside its set, or one field too many is a refusal. */
export function readNavEvent(value: unknown): NavEvent | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const keys = Object.keys(row).sort().join(',')
  if (!has(FULL_KINDS, row.kind)) return null
  if (row.name === 'full_open' && keys === 'from,kind,name' && has(NAV_PLACES, row.from)) {
    return { name: 'full_open', kind: row.kind, from: row.from }
  }
  if (row.name === 'full_back' && keys === 'by,kind,name,previous,to' && has(NAV_PLACES, row.to) && has(BACK_INPUTS, row.by) && typeof row.previous === 'boolean') {
    return { name: 'full_back', kind: row.kind, to: row.to, by: row.by, previous: row.previous }
  }
  if (row.name === 'full_leave' && keys === 'kind,name,to' && has(NAV_PLACES, row.to)) {
    return { name: 'full_leave', kind: row.kind, to: row.to }
  }
  return null
}

/** The count's key: the event's fields in one fixed order, so one shape is one row. */
export function navKey(event: NavEvent): string {
  switch (event.name) {
    case 'full_open':
      return `full_open ${event.kind} from=${event.from}`
    case 'full_back':
      return `full_back ${event.kind} to=${event.to} by=${event.by} ${event.previous ? 'previous' : 'step-out'}`
    case 'full_leave':
      return `full_leave ${event.kind} to=${event.to}`
  }
}

export type NavCounts = Readonly<Record<string, Readonly<Record<string, number>>>>

/** The counts with one more event on `day`, days older than KEEP_DAYS dropped. */
export function countNav(counts: NavCounts, event: NavEvent, day: string): NavCounts {
  const key = navKey(event)
  const today = counts[day] ?? {}
  const next: Record<string, Readonly<Record<string, number>>> = { ...counts, [day]: { ...today, [key]: (today[key] ?? 0) + 1 } }
  const kept = Object.keys(next).sort().slice(-KEEP_DAYS)
  return Object.fromEntries(kept.map((d) => [d, next[d]]))
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

const storage = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The counts kept on this machine; empty where storage is unreadable. */
export function readNavCounts(): NavCounts {
  try {
    const raw = JSON.parse(storage()?.getItem(NAV_STORAGE_KEY) ?? 'null') as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
    const days = Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, number>] =>
        /^\d{4}-\d{2}-\d{2}$/.test(entry[0]) &&
        typeof entry[1] === 'object' &&
        entry[1] !== null &&
        Object.values(entry[1]).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)
    )
    return Object.fromEntries(days)
  } catch {
    return {}
  }
}

let recent: readonly { readonly event: NavEvent; readonly at: number }[] = []
const listeners = new Set<(event: NavEvent) => void>()

/** The last RECENT events this page tracked, oldest first. */
export const recentNav = (): readonly { readonly event: NavEvent; readonly at: number }[] => recent

export function subscribeNav(listener: (event: NavEvent) => void): () => void {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** Count one event. Anything readNavEvent would refuse is dropped. */
export function trackNav(value: NavEvent, now: number = Date.now()): void {
  const event = readNavEvent(value)
  if (event === null) return
  recent = [...recent, { event, at: now }].slice(-RECENT)
  const store = storage()
  if (store) {
    try {
      store.setItem(NAV_STORAGE_KEY, JSON.stringify(countNav(readNavCounts(), event, dayOf(now))))
    } catch {
      // full or private storage: this one is not counted
    }
  }
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // a reader's fault is its own
    }
  }
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(NAV_DOM_EVENT, { detail: event }))
    }
  } catch {
    // no window to tell
  }
}
