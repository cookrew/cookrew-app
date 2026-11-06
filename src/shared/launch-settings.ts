import { originOf } from './pairing-url'

/**
 * LAUNCH SETTINGS: what the app reads once, as it starts.
 *
 * They were a launch line (launch-defaults.ts), and a Mac app opened from the Dock
 * has no launch line. The defaults ARE that line, so a person who never opens the
 * sheet runs what the owner runs. An explicit variable still wins over a saved
 * choice, and the sheet shows it locked rather than offering a change that cannot
 * take effect.
 */

export const DEFAULT_REGISTRY = 'https://cookrew.dev'
export const DEFAULT_MULTIPLEXER = 'herdr'

/** The hosts a person can pick. A variable may still name something else. */
export const LAUNCH_MULTIPLEXERS = ['herdr', 'tmux', 'direct'] as const

export interface LaunchValues {
  /** Only a variable can make this empty (launch-defaults.ts, relayOrigin). */
  readonly registry: string
  readonly interactiveBrowser: boolean
  readonly multiInstance: boolean
  readonly multiplexer: string
}

export type LaunchKey = keyof LaunchValues
export type LaunchChoices = Partial<LaunchValues>

export const LAUNCH_KEYS: readonly LaunchKey[] = ['registry', 'interactiveBrowser', 'multiInstance', 'multiplexer']

export const LAUNCH_DEFAULTS: LaunchValues = {
  registry: DEFAULT_REGISTRY,
  interactiveBrowser: true,
  multiInstance: true,
  multiplexer: DEFAULT_MULTIPLEXER
}

export const LAUNCH_ENV: Readonly<Record<LaunchKey, string>> = {
  registry: 'COOKREW_REGISTRY',
  interactiveBrowser: 'COOKREW_INTERACTIVE_BROWSER',
  multiInstance: 'COOKREW_MULTI_INSTANCE',
  multiplexer: 'COOKREW_MULTIPLEXER'
}

export interface LaunchStatus {
  /** What the next start will use. */
  readonly values: LaunchValues
  /** What this run is using. */
  readonly running: LaunchValues
  /** Held by a variable from this launch, so the sheet cannot change them. */
  readonly pinned: readonly LaunchKey[]
  /** The next start would differ from this run. */
  readonly restart: boolean
  /** A session belongs to one registry, so the registry holds still while there is one. */
  readonly signedIn: boolean
}

export type LaunchSaveFailure = 'invalid-registry' | 'invalid-choice' | 'signed-in' | 'write-failed' | 'not-owner'
export type LaunchSaveResult = { readonly ok: true; readonly status: LaunchStatus } | { readonly ok: false; readonly reason: LaunchSaveFailure }

/**
 * An origin to use, or null. Accounts and pairing go here, so it is https or loopback.
 *
 * Never empty. An empty variable turns off the doors, but the phone line still dials
 * cookrew.dev, so "relay off" is a promise a settings sheet could not keep.
 */
export function registryValue(raw: unknown): string | null {
  return typeof raw === 'string' ? originOf(raw.trim()) : null
}

const isHost = (raw: unknown): raw is string => LAUNCH_MULTIPLEXERS.some((host) => host === raw)

/** What can be used out of anything at all: a hand-edited file loses a line, not the rest. */
export function parseLaunchChoices(raw: unknown): LaunchChoices {
  if (typeof raw !== 'object' || raw === null) return {}
  const { registry, interactiveBrowser, multiInstance, multiplexer } = raw as Record<string, unknown>
  const origin = registryValue(registry)
  return {
    ...(origin === null ? {} : { registry: origin }),
    ...(typeof interactiveBrowser === 'boolean' ? { interactiveBrowser } : {}),
    ...(typeof multiInstance === 'boolean' ? { multiInstance } : {}),
    ...(isHost(multiplexer) ? { multiplexer } : {})
  }
}
