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
