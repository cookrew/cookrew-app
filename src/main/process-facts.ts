// WHAT A PID IS, BEYOND A NUMBER.
//
// `kill(pid, 0)` says only that the number is taken. A zombie answers it though
// it has ended (a close would call it still running), and a pid can come back as
// someone else's process (a later retry must not signal that). `ps` tells both.

import { execFile } from 'node:child_process'

export type ProcessFact =
  | { readonly state: 'running'; readonly started: string }
  | { readonly state: 'gone' }
  /** ps gave no answer, so nothing may be concluded. */
  | { readonly state: 'unknown' }

const PS_TIMEOUT_MS = 2000

/** `ps -o stat=,lstart=` for one pid: state letters, then the start time. */
export function parseProcessLine(line: string): ProcessFact {
  const text = line.trim()
  if (text.length === 0) return { state: 'gone' }
  const split = text.search(/\s/)
  const stat = split === -1 ? text : text.slice(0, split)
  if (stat.startsWith('Z')) return { state: 'gone' }
  return { state: 'running', started: split === -1 ? '' : text.slice(split).trim() }
}

export function processFact(pid: number): Promise<ProcessFact> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'stat=,lstart=', '-p', String(pid)],
      // Pinned, or the same process reads differently across a locale change.
      { encoding: 'utf8', timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
      (error, stdout) => {
        // ps exits 1 when the pid is not there; anything else is no answer.
        if (error) resolve(error.code === 1 ? { state: 'gone' } : { state: 'unknown' })
        else resolve(parseProcessLine(stdout))
      }
    )
  })
}
