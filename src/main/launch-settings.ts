import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import {
  LAUNCH_DEFAULTS,
  LAUNCH_ENV,
  LAUNCH_KEYS,
  parseLaunchChoices,
  registryValue,
  type LaunchChoices,
  type LaunchKey,
  type LaunchSaveResult,
  type LaunchStatus,
  type LaunchValues
} from '../shared/launch-settings'
import { writeFileAtomic } from './atomic-file'
import { launchValues } from './launch-defaults'

/**
 * THE SAVED HALF OF LAUNCH SETTINGS (shared/launch-settings.ts).
 *
 * A saved choice becomes the variable the app already reads, set before any other
 * module loads (launch-settings-boot.ts). Every reader stays as it was, and one
 * order holds everywhere: a variable from the launch, then the file, then the default.
 *
 * The file holds only what differs from the default, so nothing new reaches a pane's
 * environment for a person who chose nothing, and a later default still arrives.
 */

type Env = Record<string, string | undefined>

/**
 * Which variables came from the file. A relaunch inherits this process's environment,
 * so without this the next run would read a saved choice as a variable from the launch:
 * locked in the sheet, and still in force after the file stopped saying so.
 */
const APPLIED_ENV = 'COOKREW_LAUNCH_APPLIED'

export interface LaunchBoot {
  /** The launch's own variables, before the file was applied. */
  readonly before: Readonly<Env>
  /** What this run is using. */
  readonly running: LaunchValues
}

export interface LaunchSettings {
  status(): LaunchStatus
  save(input: unknown): LaunchSaveResult
}

export const launchSettingsPath = (home: string): string => path.join(home, '.cookrew', 'launch-settings.json')

export function readLaunchChoices(file: string): LaunchChoices {
  try {
    return parseLaunchChoices(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // None yet, or damaged: the defaults are a working app.
    return {}
  }
}

const envValue = (value: string | boolean): string => (typeof value === 'boolean' ? (value ? '1' : '0') : value)

/** The variables a set of choices adds to an environment. What is already set stays. */
export function launchEnvOf(choices: LaunchChoices, env: Readonly<Env>): Record<string, string> {
  const added = LAUNCH_KEYS.flatMap((key) => {
    const value = choices[key]
    return value === undefined || env[LAUNCH_ENV[key]] !== undefined ? [] : [[LAUNCH_ENV[key], envValue(value)]]
  })
  return Object.fromEntries(added)
}

/** Writes into `env`: called on process.env, once, before anything reads it. */
export function bootLaunchSettings(env: Env, file: string): LaunchBoot {
  const inherited = (env[APPLIED_ENV] ?? '').split(',')
  for (const key of LAUNCH_KEYS) if (inherited.includes(LAUNCH_ENV[key])) delete env[LAUNCH_ENV[key]]
  delete env[APPLIED_ENV]
  const before = Object.fromEntries(LAUNCH_KEYS.map((key) => [LAUNCH_ENV[key], env[LAUNCH_ENV[key]]]))
  const added = launchEnvOf(readLaunchChoices(file), before)
  Object.assign(env, added, Object.keys(added).length > 0 ? { [APPLIED_ENV]: Object.keys(added).join(',') } : {})
  return { before, running: launchValues(env) }
}

const isPinned = (boot: LaunchBoot, key: LaunchKey): boolean => boot.before[LAUNCH_ENV[key]] !== undefined

const pick = (choices: LaunchChoices, keep: (key: LaunchKey) => boolean): LaunchChoices =>
  Object.fromEntries(LAUNCH_KEYS.filter((key) => choices[key] !== undefined && keep(key)).map((key) => [key, choices[key]]))

/** Why this cannot be saved, or null. Stricter than reading: the person is here to be told. */
function refusal(asked: Record<string, unknown>): 'invalid-registry' | 'invalid-choice' | null {
  if (asked.registry !== undefined && registryValue(asked.registry) === null) return 'invalid-registry'
  const parsed = parseLaunchChoices(asked)
  return LAUNCH_KEYS.some((key) => asked[key] !== undefined && parsed[key] === undefined) ? 'invalid-choice' : null
}

export interface LaunchSettingsDeps {
  readonly file: string
  readonly boot: LaunchBoot
  readonly signedIn: () => boolean
}

export function createLaunchSettings({ file, boot, signedIn }: LaunchSettingsDeps): LaunchSettings {
  const status = (): LaunchStatus => {
    const values = launchValues({ ...boot.before, ...launchEnvOf(readLaunchChoices(file), boot.before) })
    return {
      values,
      running: boot.running,
      pinned: LAUNCH_KEYS.filter((key) => isPinned(boot, key)),
      restart: LAUNCH_KEYS.some((key) => values[key] !== boot.running[key]),
      signedIn: signedIn()
    }
  }

  const save = (input: unknown): LaunchSaveResult => {
    if (typeof input !== 'object' || input === null) return { ok: false, reason: 'invalid-choice' }
    // Locked values first: the sheet sends them back, and they are not this save's to judge.
    const editable = Object.fromEntries(Object.entries(input).filter(([key]) => !LAUNCH_KEYS.some((name) => name === key && isPinned(boot, name))))
    const reason = refusal(editable)
    if (reason !== null) return { ok: false, reason }
    const asked = parseLaunchChoices(editable)
    // A bearer token goes wherever the registry points: sign out first.
    if (signedIn() && asked.registry !== undefined && asked.registry !== status().values.registry) return { ok: false, reason: 'signed-in' }
    const changed = pick(asked, (key) => asked[key] !== LAUNCH_DEFAULTS[key])
    const held = pick(readLaunchChoices(file), (key) => isPinned(boot, key))
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileAtomic(file, `${JSON.stringify({ ...held, ...changed })}\n`)
    } catch (error) {
      console.error('Failed to save the launch settings:', error)
      return { ok: false, reason: 'write-failed' }
    }
    return { ok: true, status: status() }
  }

  return { status, save }
}
