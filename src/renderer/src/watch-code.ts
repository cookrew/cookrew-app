import { hostPlatform, machineTable } from '../../shared/machine-words'

/** Six digits for a watch, as the Mac mints them (main/watch-pairing.ts). */
export interface WatchCode {
  code: string
  expiresAt: number
  bases: { kind: string; url: string }[]
  /** Arrivals so far: the sheet waits for one more than this. */
  claims: number
}

/** What a sheet has to ask for, and whether a code on offer is still standing. */
export interface WatchState {
  paired: boolean
  pending: { expiresAt: number } | null
  account: 'none' | 'password' | 'passwordless'
  /** False on a plain-HTTP page: no password may be typed here, let alone sent. */
  sealed: boolean
  /** Watches that have arrived; a sheet compares this with what it saw on opening. */
  claims: number
}

/** The account's join code for a watch, or why not (main/watch-routes.ts). */
export type WatchInvite =
  | { ok: true; code: string; expiresAt: number; claims: number }
  | { ok: false; reason: string; message?: string }

const REFUSALS: Readonly<Record<string, string>> = machineTable({
  bad_credentials: "That password isn't right.",
  rate_limited: 'Too many tries. Wait a little, then try again.',
  provider_required: 'Your account has no password, so this has to be done on the Mac.',
  password_change_required: 'Change your password first.',
  not_sealed: "This page isn't encrypted, so it can't take your password. Use the Mac, or open Cookrew over https.",
  no_account: 'Sign in on this Mac first.',
  locked: 'Unlock this Mac first.'
}, hostPlatform())

/** A refusal in words a person can act on. */
export const inviteRefusal = (reason: string, message?: string): string =>
  REFUSALS[reason] ?? message ?? "That didn't work. Try again."

/**
 * Did the watch arrive? Counted, because a code also leaves the Mac by running out
 * or being burned by wrong guesses, and with an older watch still paired that would
 * look the same.
 */
export const watchClaimed = (state: WatchState, seen: number, expiresAt: number, now: number): boolean =>
  state.claims > seen && now < expiresAt

/** "482 193": two halves are what the eye carries to a wrist. */
export const spacedCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`

/** The address to type on the watch: its host and any port, no scheme. */
export function typedAddress(bases: WatchCode['bases']): string | null {
  const base = bases.find((one) => one.kind === 'lan') ?? bases.find((one) => one.kind === 'tailnet') ?? bases[0]
  if (!base) return null
  const url = new URL(base.url)
  return url.port === '8639' ? url.hostname : url.host
}

/** "4:59", the time a code has left; null once it has none. */
export function timeLeft(expiresAt: number, now: number): string | null {
  const seconds = Math.ceil((expiresAt - now) / 1000)
  if (seconds <= 0) return null
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
