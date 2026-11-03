// Who owns Cookrew's herdr session.
//
// The session name is a constant (HERDR_SESSION), and herdr finds its socket
// through HERDR_SOCKET_PATH before HOME — so a second Cookrew with its own
// userData and HOME, launched from a Cookrew pane, still reaches the live
// app's server. On 2026-09-18 one did, took the 56 panes for orphans and
// closed every one of them.
//
// The single-instance lock cannot see that instance (it is keyed by userData).
// This claim can: a small JSON file in the session's own state directory —
// derived exactly the way herdr derives its socket, so "same socket" means
// "same claim" — holding the owner's pid, its process start stamp and its
// userData. The same live-probe idea as socket-claim.ts:
//   - nobody, a dead pid, or a pid reused by a later process  -> take it
//   - a live owner with the same userData -> the single-instance lock decides
//     (a duplicate launch about to exit, or our predecessor still exiting);
//     confirmHerdrClaim() replaces it once that lock is held
//   - a live owner with another userData -> foreign: hands off
//
// A start stamp that cannot be read counts as a match: an unprovable takeover
// is the failure this file exists to prevent. For the same reason a process
// that cannot read its OWN stamp writes no claim at all — a null stamp would
// disable pid-reuse detection for that record forever. The stamp is read with
// a pinned TZ and locale: `ps -o lstart` formats in the caller's, and a live
// owner read under another TZ looked like a reused pid.

import { execFileSync } from 'node:child_process'
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const OWNER_FILE = 'cookrew-owner.json'

export interface OwnerRecord {
  pid: number
  /** The owner's process start stamp (`ps -o lstart=`), null when unreadable. */
  started: string | null
  /** The owner's userData path — what the single-instance lock is keyed by. */
  instance: string
  /** When the claim was written (ISO). */
  at: string
}

export interface ClaimDeps {
  pid: number
  instance: string
  isAlive: (pid: number) => boolean
  startOf: (pid: number) => string | null
  now: () => Date
}

export type ClaimState =
  | { kind: 'free' }
  /** `raw`: the exact bytes judged stale, so a takeover can check it moved THEM. */
  | { kind: 'stale'; raw: string }
  | { kind: 'ours' }
  | { kind: 'same-instance'; owner: OwnerRecord; raw: string }
  | { kind: 'foreign'; owner: OwnerRecord }
  | { kind: 'unknown'; reason: string }

export type ClaimVerdict =
  | { kind: 'owned' }
  | { kind: 'same-instance'; owner: OwnerRecord }
  | { kind: 'foreign'; owner: OwnerRecord }
  | { kind: 'unknown'; reason: string }

/**
 * The directory herdr keeps this session in: next to HERDR_SOCKET_PATH when
 * that is set (herdr ranks it first), else
 * `${XDG_CONFIG_HOME:-$HOME/.config}/herdr/sessions/<session>`. Null when
 * there is no HOME — herdr cannot locate one either.
 */
export function herdrSessionDir(session: string, env: NodeJS.ProcessEnv): string | null {
  if (env.HERDR_SOCKET_PATH) return path.dirname(env.HERDR_SOCKET_PATH)
  const configHome = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, '.config') : null)
  return configHome ? path.join(configHome, 'herdr', 'sessions', session) : null
}

export function ownerFile(dir: string): string {
  return path.join(dir, OWNER_FILE)
}

/**
 * Do two userData paths name the same directory? macOS and Windows file
 * systems are case-insensitive by default: the dev build's `.../cookrew` and
 * the packaged `.../Cookrew` share one single-instance lock, so they are one
 * instance here too.
 */
export function sameInstance(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'darwin' || platform === 'win32') return a.toLowerCase() === b.toLowerCase()
  return a === b
}

function isRecord(value: unknown): value is OwnerRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as Record<string, unknown>
  return (
    Number.isInteger(r.pid) &&
    (r.pid as number) > 0 &&
    typeof r.instance === 'string' &&
    (r.started === null || typeof r.started === 'string')
  )
}

type ReadResult =
  | { kind: 'none' }
  | { kind: 'corrupt'; raw: string }
  | { kind: 'record'; record: OwnerRecord; raw: string }

function readRaw(at: string): string | null {
  try {
    return readFileSync(at, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parseOwner(raw: string): OwnerRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readOwner(dir: string): ReadResult {
  const raw = readRaw(ownerFile(dir))
  if (raw === null) return { kind: 'none' }
  const record = parseOwner(raw)
  return record ? { kind: 'record', record, raw } : { kind: 'corrupt', raw }
}

/** Two start stamps disagree only when both are known and differ. */
const startsDiffer = (a: string | null, b: string | null): boolean => a !== null && b !== null && a !== b

function judge(record: OwnerRecord, raw: string, deps: ClaimDeps): ClaimState {
  if (record.pid === deps.pid) {
    // Our pid — but possibly a dead owner's pid that this process reused.
    return startsDiffer(record.started, deps.startOf(deps.pid)) ? { kind: 'stale', raw } : { kind: 'ours' }
  }
  if (!deps.isAlive(record.pid)) return { kind: 'stale', raw }
  if (startsDiffer(record.started, deps.startOf(record.pid))) return { kind: 'stale', raw }
  return sameInstance(record.instance, deps.instance)
    ? { kind: 'same-instance', owner: record, raw }
    : { kind: 'foreign', owner: record }
}

/** Read the claim without writing anything. */
export function inspectHerdrClaim(dir: string, deps: ClaimDeps): ClaimState {
  try {
    const read = readOwner(dir)
    if (read.kind === 'none') return { kind: 'free' }
    if (read.kind === 'corrupt') return { kind: 'stale', raw: read.raw }
    return judge(read.record, read.raw, deps)
  } catch (error) {
    return { kind: 'unknown', reason: (error as Error).message }
  }
}

function unlinkQuietly(at: string): void {
  try {
    unlinkSync(at)
  } catch {
    // Absent is the goal.
  }
}

/**
 * Write our record. 'create' fails with 'exists' instead of overwriting a
 * claim that appeared since we looked; 'replace' swaps the file atomically.
 */
/**
 * Create our record; never overwrites. link() fails with EEXIST instead of
 * replacing a claim that appeared since we looked, so only one booter wins.
 */
function createOwner(dir: string, deps: ClaimDeps, started: string): 'written' | 'exists' {
  mkdirSync(dir, { recursive: true })
  const record: OwnerRecord = { pid: deps.pid, started, instance: deps.instance, at: deps.now().toISOString() }
  const staging = path.join(dir, `${OWNER_FILE}.${deps.pid}.tmp`)
  writeFileSync(staging, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  try {
    linkSync(staging, ownerFile(dir))
    return 'written'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
    throw error
  } finally {
    unlinkQuietly(staging)
  }
}

/**
 * Move the claim file aside, keep it gone only if it is `expected`, and put
 * anything else back. Compare-and-delete: a plain unlink or rename-over could
 * remove a claim a contender wrote after our look. True when removed.
 */
function removeIfStill(dir: string, deps: ClaimDeps, expected: (raw: string) => boolean): boolean {
  const aside = path.join(dir, `${OWNER_FILE}.${deps.pid}.old`)
  try {
    renameSync(ownerFile(dir), aside)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  try {
    const moved = readRaw(aside)
    if (moved !== null && expected(moved)) return true
    // Not the one we meant: restore it unless somebody claimed meanwhile.
    try {
      linkSync(aside, ownerFile(dir))
    } catch {
      // EEXIST: a newer claim already sits there; it outranks the one we moved.
    }
    return false
  } finally {
    unlinkQuietly(aside)
  }
}

/** A state seen AFTER our write: only our own record counts as owned. */
function settled(state: ClaimState): ClaimVerdict {
  switch (state.kind) {
    case 'ours':
      return { kind: 'owned' }
    case 'foreign':
    case 'same-instance':
    case 'unknown':
      return state
    default:
      return { kind: 'unknown', reason: 'the claim changed while it was being taken' }
  }
}

/** Create our record (never overwriting) and read back who actually holds it. */
function take(dir: string, deps: ClaimDeps): ClaimVerdict {
  const started = deps.startOf(deps.pid)
  if (started === null) return { kind: 'unknown', reason: 'this process cannot read its own start time' }
  createOwner(dir, deps, started)
  return settled(inspectHerdrClaim(dir, deps))
}

/**
 * Take over a claim judged stale (or a same-instance predecessor's), but only
 * if the file still holds exactly `judgedRaw`. Two booters that both judged
 * the same record stale cannot both win: one moves it aside, the other finds
 * it gone or changed, and the final create is exclusive. Exported for tests.
 */
export function replaceStaleClaim(dir: string, deps: ClaimDeps, judgedRaw: string): ClaimVerdict {
  try {
    removeIfStill(dir, deps, (raw) => raw === judgedRaw)
    return take(dir, deps)
  } catch (error) {
    return { kind: 'unknown', reason: (error as Error).message }
  }
}

/** Claim the session unless a live owner holds it. Never throws. */
export function claimHerdrSession(dir: string, deps: ClaimDeps): ClaimVerdict {
  try {
    const state = inspectHerdrClaim(dir, deps)
    switch (state.kind) {
      case 'ours':
        return { kind: 'owned' }
      case 'free':
        return take(dir, deps)
      case 'stale':
        return replaceStaleClaim(dir, deps, state.raw)
      case 'same-instance':
        return { kind: 'same-instance', owner: state.owner }
      default:
        return state
    }
  } catch (error) {
    return { kind: 'unknown', reason: (error as Error).message }
  }
}

/**
 * Call once the single-instance lock is held: a live owner with our own
 * userData can then only be a predecessor on its way out, so it is replaced.
 * A live FOREIGN owner is still never overwritten. Never throws.
 */
export function confirmHerdrClaim(dir: string, deps: ClaimDeps): ClaimVerdict {
  try {
    const state = inspectHerdrClaim(dir, deps)
    if (state.kind === 'ours') return { kind: 'owned' }
    if (state.kind === 'foreign' || state.kind === 'unknown') return state
    return state.kind === 'free' ? take(dir, deps) : replaceStaleClaim(dir, deps, state.raw)
  } catch (error) {
    return { kind: 'unknown', reason: (error as Error).message }
  }
}

/** Remove the claim only while it is ours. True when it was removed. */
export function releaseHerdrClaim(dir: string, deps: ClaimDeps): boolean {
  if (inspectHerdrClaim(dir, deps).kind !== 'ours') return false
  try {
    // Re-checked on the moved bytes: a takeover between the look and the
    // remove must survive our quit.
    return removeIfStill(dir, deps, (raw) => {
      const record = parseOwner(raw)
      return record !== null && judge(record, raw, deps).kind === 'ours'
    })
  } catch {
    return false
  }
}

export type PsExec = (file: string, args: string[], env: NodeJS.ProcessEnv) => string

const defaultPsExec: PsExec = (file, args, env) =>
  execFileSync(file, args, { encoding: 'utf8', timeout: 2000, env, stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * A process's start stamp, the same bytes whoever asks: TZ and locale are
 * pinned. Null when ps cannot answer (the pid is gone, or ps timed out).
 */
export function readStartStamp(pid: number, exec: PsExec = defaultPsExec): string | null {
  try {
    const out = exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
      PATH: '/usr/bin:/bin',
      TZ: 'UTC',
      LC_ALL: 'C'
    })
    return out.trim() || null
  } catch {
    return null
  }
}

/** The real process table. */
export function processClaimDeps(instance: string): ClaimDeps {
  const starts = new Map<number, string>()
  return {
    pid: process.pid,
    instance,
    isAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        // EPERM: alive, just not ours to signal.
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    startOf: (pid) => {
      // Our own start never changes, so a stamp once read is kept; a failed
      // read is not, and is retried. Other pids are asked fresh every time.
      const cached = pid === process.pid ? starts.get(pid) : undefined
      if (cached) return cached
      const stamp = readStartStamp(pid)
      if (pid === process.pid && stamp) starts.set(pid, stamp)
      return stamp
    },
    now: () => new Date()
  }
}
