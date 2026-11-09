import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from './atomic-file'
import type { PairAnchors, PasskeyAnchor } from './pair-anchors'

/**
 * THE PASSKEYS THIS MACHINE TRUSTS, PINNED ON FIRST USE.
 *
 * cookrew.dev holds the account, so it is where the passkeys are first read.
 * It must not also be able to ADD one later and walk in with it: that would be
 * the registry admitting itself to every machine of every account with nobody
 * involved. So the machine writes down the account's passkeys the first time
 * an entry is asked of it, and from then on:
 *
 *   a passkey the registry no longer lists stops opening (a removal is honoured
 *   — it is how an owner takes a lost authenticator away);
 *   a passkey the registry adds opens nothing until somebody at the machine
 *   runs `cookrew mobile --repin`, which reads and pins the list again.
 *
 * Kept per username: a machine signed in to another account starts over.
 * 0600 and temp-and-rename, like every other credential file here.
 */

export interface PinnedPasskey {
  readonly credentialId: string
  readonly jwk: Record<string, string>
}

export interface PairPins {
  readonly username: string
  readonly passkeys: readonly PinnedPasskey[]
  readonly at: number
}

export interface PinStore {
  read(): PairPins | null
  write(pins: PairPins): void
}

const sameJwk = (a: Record<string, string>, b: Record<string, string>): boolean =>
  a.kty === b.kty && a.crv === b.crv && a.x === b.x && a.y === b.y

export const pinsFrom = (anchors: PairAnchors, at: number): PairPins => ({
  username: anchors.username,
  passkeys: anchors.passkeys.map((p) => ({ credentialId: p.credentialId, jwk: p.jwk })),
  at
})

/** The passkeys that open this machine: pinned here AND still on the account, key for key. */
export const trustedPasskeys = (pins: PairPins | null, anchors: PairAnchors): PasskeyAnchor[] => {
  if (pins === null || pins.username !== anchors.username) return []
  return anchors.passkeys.filter((listed) =>
    pins.passkeys.some((pinned) => pinned.credentialId === listed.credentialId && sameJwk(pinned.jwk, listed.jwk))
  )
}

/** What a re-pin changed, by credential id, so the CLI can say it. */
export const pinChanges = (before: PairPins | null, after: PairPins): { added: string[]; removed: string[] } => {
  const had = new Set(before?.username === after.username ? before.passkeys.map((p) => p.credentialId) : [])
  const has = new Set(after.passkeys.map((p) => p.credentialId))
  return { added: [...has].filter((id) => !had.has(id)), removed: [...had].filter((id) => !has.has(id)) }
}

const looksLikePins = (value: unknown): value is PairPins => {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.username === 'string' &&
    typeof v.at === 'number' &&
    Array.isArray(v.passkeys) &&
    v.passkeys.every(
      (p) =>
        typeof p === 'object' && p !== null && typeof (p as PinnedPasskey).credentialId === 'string' && typeof (p as PinnedPasskey).jwk === 'object'
    )
  )
}

export function pairPinsFile(file: string): PinStore {
  return {
    read: () => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        return looksLikePins(parsed) ? parsed : null
      } catch {
        return null
      }
    },
    write: (pins) => {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      writeFileAtomic(file, JSON.stringify(pins))
      chmodSync(file, 0o600)
    }
  }
}

/** For tests and for an embedder with no home directory. */
export function memoryPins(initial: PairPins | null = null): PinStore {
  let held = initial
  return { read: () => held, write: (pins) => void (held = pins) }
}
