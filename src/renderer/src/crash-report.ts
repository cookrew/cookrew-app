import { isRemoteMode } from './api'
import { apiPath } from './api-base'
import { authHeaders } from './auth-gate'
import { planeFetch } from './plane-fetch'

/**
 * WHAT A RENDER CRASH LEAVES BEHIND.
 *
 * The crash screen used to log one line to the console, which on a phone
 * never reaches the Mac: the owner's phone fell into it again and again on
 * 2026-10-31 and the only trace was the black box's DOM count dropping to
 * thirty. Now the error, its stack and the React component trail go to the
 * console (the desktop log carries it) and, from a phone, to the black box on
 * the Mac (phone-beacon.ts), where the dev log prints it too.
 */

export interface CrashReport {
  readonly crash: true
  readonly message: string
  readonly stack: string
  readonly component: string
  /** The path only: the query carries the pairing token. */
  readonly path: string
  readonly t: number
}

const MAX = 4000

export function crashReport(error: unknown, componentStack: string | null | undefined, path: string, now: number): CrashReport {
  const err = error instanceof Error ? error : new Error(String(error))
  return {
    crash: true,
    message: (err.message || err.name || 'unknown error').slice(0, 500),
    stack: (err.stack ?? '').slice(0, MAX),
    component: (componentStack ?? '').trim().slice(0, MAX),
    path: path.slice(0, 200),
    t: now
  }
}

export function reportCrash(error: unknown, componentStack: string | null | undefined): CrashReport {
  const report = crashReport(error, componentStack, window.location.pathname, Date.now())
  console.error(`[cookrew] render crash: ${report.message}\n${report.stack}\ncomponents:${report.component}`)
  if (isRemoteMode()) {
    try {
      void planeFetch(apiPath('/api/beacon'), {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(report),
        keepalive: true
      }).catch(() => undefined)
    } catch {
      // Reporting a crash must never be a second one.
    }
  }
  return report
}

/**
 * A CHUNK THAT IS NOT THERE ANY MORE IS A NEW BUILD, NOT A BUG.
 *
 * Every merge rebuilds the bundle the phone loads, under new chunk names. A
 * page loaded before the rebuild asks for a chunk name that is gone, and the
 * import fails with one of these sentences (Chrome, Safari, Firefox). The
 * answer is to load the page again — once: a reload within RELOAD_GUARD_MS
 * of the last is not repeated, so a chunk that is truly missing shows the
 * crash screen instead of looping.
 */
const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (CSS )?chunk \S+ failed/i

export const RELOAD_GUARD_MS = 30_000
const RELOAD_KEY = 'cookrew.new-build-reload-at'

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return CHUNK_ERROR.test(message)
}

export interface ReloadDeps {
  readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null
  readonly now: number
  readonly reload: () => void
}

/** Reloads unless a reload for a new build happened within the guard; says which. */
export function reloadForNewBuild(deps: ReloadDeps): boolean {
  let last = 0
  try {
    last = Number(deps.storage?.getItem(RELOAD_KEY) ?? 0) || 0
  } catch {
    last = 0
  }
  if (deps.now - last < RELOAD_GUARD_MS) return false
  try {
    deps.storage?.setItem(RELOAD_KEY, String(deps.now))
  } catch {
    // No storage: the guard cannot hold, so do not reload at all.
    return false
  }
  deps.reload()
  return true
}

export function reloadForNewBuildNow(): boolean {
  let storage: Storage | null = null
  try {
    storage = window.sessionStorage
  } catch {
    storage = null
  }
  return reloadForNewBuild({ storage, now: Date.now(), reload: () => window.location.reload() })
}
