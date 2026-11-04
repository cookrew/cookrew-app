/**
 * THE ONBOARDING FUNNEL'S ALLOWLIST — the whole privacy promise, in one file.
 *
 * Five events, each at most once per install, and five fields. The app builds
 * its payload through `readFunnelPayload` and the registry accepts one through
 * the same function, so nothing can leave that this file did not name and
 * nothing can be counted that it would refuse.
 *
 * Every field is a closed set or a shape too narrow to carry text: a version is
 * numbers, an OS is a family, an id is a random UUID, a time is a UTC day. Never
 * a prompt, a path, a card name, a username, an email, a repo or model output.
 * Adding a field here is a privacy decision, not a refactor.
 */

/**
 * THE DEFAULT, in one place. Off: nothing leaves an install unless its owner
 * pressed the row. Turning this on is the product owner's ruling, not a code
 * change anyone makes in passing, because it decides who is asked before data
 * leaves their machine in every market the product sells in.
 */
export const TELEMETRY_DEFAULT_ON = false

export const FUNNEL_EVENTS = ['installed', 'preflight_passed', 'first_turn_done', 'phone_paired', 'paid'] as const
export type FunnelEvent = (typeof FUNNEL_EVENTS)[number]

export const OS_FAMILIES = ['mac', 'windows', 'linux', 'other'] as const
export type OsFamily = (typeof OS_FAMILIES)[number]

export interface FunnelPayload {
  readonly event: FunnelEvent
  readonly appVersion: string
  readonly osFamily: OsFamily
  /** A random UUID minted for this install, tied to nothing else. */
  readonly installId: string
  /** A UTC day. Nothing finer exists on the wire. */
  readonly day: string
}

export const FUNNEL_PAYLOAD_KEYS = ['event', 'appVersion', 'osFamily', 'installId', 'day'] as const satisfies readonly (keyof FunnelPayload)[]

/** Where an install posts an event, and where the owner reads the totals. */
export const FUNNEL_ROUTE = '/v1/funnel'

/** What the ⋯ row shows, in the open: the same list this file enforces. */
export const TELEMETRY_ROW_NOTE =
  'When on, sends five setup steps (installed, checks passed, first turn, phone paired, paid) with the app version, ' +
  'OS family, a random ID and the day. Never prompts, paths, names or output. When off, they are counted on this machine only.'

/** What the ⋯ row needs to know. `locked` means the row cannot change it. */
export interface TelemetryStatus {
  readonly on: boolean
  readonly locked: boolean
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-(?:alpha|beta|rc)(?:\.\d{1,4})?)?$/
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/

export const isFunnelEvent = (value: unknown): value is FunnelEvent =>
  (FUNNEL_EVENTS as readonly unknown[]).includes(value)

export const isOsFamily = (value: unknown): value is OsFamily => (OS_FAMILIES as readonly unknown[]).includes(value)

export const isFunnelDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value)

export const isFunnelVersion = (value: unknown): value is string => typeof value === 'string' && VERSION.test(value)

/**
 * A payload, or null. An extra key is a refusal rather than something to strip:
 * a caller that sent a sixth field has a bug worth hearing about, and silently
 * dropping it would let the bug keep trying.
 */
export function readFunnelPayload(value: unknown): FunnelPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const keys = Object.keys(row)
  if (keys.length !== FUNNEL_PAYLOAD_KEYS.length) return null
  if (!keys.every((key) => (FUNNEL_PAYLOAD_KEYS as readonly string[]).includes(key))) return null
  const { event, appVersion, osFamily, installId, day } = row
  if (!isFunnelEvent(event) || !isFunnelVersion(appVersion) || !isOsFamily(osFamily) || !isFunnelDay(day)) return null
  if (typeof installId !== 'string' || !INSTALL_ID.test(installId)) return null
  return { event, appVersion, osFamily, installId, day }
}

/** Epoch ms to a UTC day: the only clock this feature has. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

export const osFamilyOf = (platform: string): OsFamily => {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'windows'
  return platform === 'linux' ? 'linux' : 'other'
}
