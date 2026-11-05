import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ViewerWho } from '../shared/remote-access'
import { UNLOCK_INFO, UNLOCK_PASSWORD_MAX, type UnlockAnswer, type UnlockBegin, type UnlockOutcome } from '../shared/remote-unlock'
import { generateSealKeyPair, openBody, type SealKeyPair } from '../shared/relay-seal'
import { writeFileAtomic } from './atomic-file'

/**
 * THE MAC'S SIDE OF A REMOTE UNLOCK.
 *
 * The password exists here for as long as it takes to type it. It is not stored,
 * logged or echoed: a refusal never repeats what was sent, and the record names
 * who asked and how it went. The desk's own rules (the switch, Stop, Accessibility)
 * are asked twice, because Stop can land between the challenge and the typing.
 *
 * Attempts are counted for the machine, not the device: macOS counts them that way.
 */

export const UNLOCK_ATTEMPTS = 3
export const UNLOCK_REST_MS = 60_000
export const UNLOCK_CHALLENGE_MS = 60_000
/** Past this many, a rest is not enough: the door stays shut until someone at the Mac reopens it. */
export const UNLOCK_MISSES_MAX = 9
const SETTLE_LOOKS = 15
const SETTLE_STEP_MS = 400

export interface UnlockDoorDeps {
  keyPair(): SealKeyPair
  /** Why this viewer may not unlock; null when it may. */
  refusal(who: ViewerWho): string | null
  /** A fresh read, never a cached one. */
  locked(): Promise<boolean>
  wake(): Promise<void>
  /** Every character has a key. Absent: assumed. */
  typable?(password: string): boolean
  /** Types at the lock screen and presses Return. */
  type(password: string): Promise<void>
  record(outcome: string, who: ViewerWho): void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface UnlockDoor {
  begin(who: ViewerWho): Promise<UnlockBegin>
  unlock(who: ViewerWho, wire: string): Promise<UnlockAnswer>
  /** Someone at the Mac turned remote control on. */
  reopen(): void
}

const NOT_LOCKED = 'This Mac is not locked.'
const BUSY = 'An unlock is already under way.'
const REFUSED = 'That request could not be read. Try again.'
const UNTYPABLE = 'This password cannot be typed from here: it has a character no key makes. Unlock it at the Mac.'
const CLOSED = 'Too many wrong passwords. Turn remote control off and on at the Mac to try again.'

const readSealed = (opened: string | null): { challenge: string; password: string } | null => {
  if (opened === null) return null
  try {
    const raw = JSON.parse(opened) as { c?: unknown; p?: unknown } | null
    if (typeof raw?.c !== 'string' || typeof raw.p !== 'string') return null
    return raw.p.length > 0 && raw.p.length <= UNLOCK_PASSWORD_MAX ? { challenge: raw.c, password: raw.p } : null
  } catch {
    return null
  }
}

export function createUnlockDoor(deps: UnlockDoorDeps): UnlockDoor {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const challenges = new Map<string, { value: string; until: number }>()
  let misses = 0
  let missesInAll = 0
  let restUntil = 0
  let typing = false

  /** What stops any ask, before anything is opened or read. */
  const stopped = (who: ViewerWho): { ok: false; error: string; outcome?: UnlockOutcome } | null => {
    const refusal = deps.refusal(who)
    if (refusal !== null) return { ok: false, error: refusal }
    if (typing) return { ok: false, outcome: 'busy', error: BUSY }
    if (missesInAll >= UNLOCK_MISSES_MAX) return { ok: false, outcome: 'closed', error: CLOSED }
    if (now() < restUntil) return { ok: false, outcome: 'resting', error: `Too many tries. Try again in ${Math.max(1, Math.ceil((restUntil - now()) / 1000))} s.` }
    return null
  }

  /** Takes the challenge whatever comes next: each one answers one message. */
  const spend = (who: ViewerWho, value: string): boolean => {
    const held = challenges.get(who.key)
    challenges.delete(who.key)
    return held !== undefined && held.value === value && now() <= held.until
  }

  const opensUp = async (): Promise<boolean> => {
    for (let look = 0; look < SETTLE_LOOKS; look += 1) {
      await sleep(SETTLE_STEP_MS)
      if (!(await deps.locked())) return true
    }
    return false
  }

  const missed = (who: ViewerWho): UnlockAnswer => {
    misses += 1
    missesInAll += 1
    if (misses >= UNLOCK_ATTEMPTS) {
      misses = 0
      restUntil = now() + UNLOCK_REST_MS
    }
    deps.record(missesInAll >= UNLOCK_MISSES_MAX ? 'wrong password, closed until someone at the Mac reopens it' : 'wrong password', who)
    return { ok: false, outcome: 'wrong', error: 'That password did not open this Mac.' }
  }

  const typeIt = async (who: ViewerWho, password: string): Promise<UnlockAnswer> => {
    try {
      await deps.wake()
      // Waking takes seconds, and Stop can land in them.
      const refusal = deps.refusal(who)
      if (refusal !== null) return { ok: false, error: refusal }
      await deps.type(password)
      if (!(await opensUp())) return missed(who)
      misses = 0
      missesInAll = 0
      deps.record('unlocked', who)
      return { ok: true, outcome: 'unlocked' }
    } catch {
      // The hand stops when the lock goes: someone at the Mac got there first.
      if (!(await deps.locked().catch(() => true))) return { ok: false, outcome: 'not-locked', error: NOT_LOCKED }
      deps.record('could not type', who)
      return { ok: false, outcome: 'failed', error: 'Could not type at the lock screen. Try again, or unlock it at the Mac.' }
    }
  }

  return {
    async begin(who) {
      const stop = stopped(who)
      if (stop !== null) return stop
      if (!(await deps.locked())) return { ok: false, outcome: 'not-locked', error: NOT_LOCKED }
      const value = randomBytes(32).toString('base64url')
      challenges.set(who.key, { value, until: now() + UNLOCK_CHALLENGE_MS })
      return { ok: true, key: deps.keyPair().publicKey, challenge: value }
    },
    async unlock(who, wire) {
      const stop = stopped(who)
      if (stop !== null) return stop
      const sealed = readSealed(openBody(deps.keyPair().privateKey, UNLOCK_INFO, wire))
      if (sealed === null || !spend(who, sealed.challenge)) {
        challenges.delete(who.key)
        return { ok: false, outcome: 'refused', error: REFUSED }
      }
      if (deps.typable && !deps.typable(sealed.password)) return { ok: false, outcome: 'failed', error: UNTYPABLE }
      // Before the first await: two devices must not both get past this line.
      typing = true
      try {
        if (!(await deps.locked())) return { ok: false, outcome: 'not-locked', error: NOT_LOCKED }
        return await typeIt(who, sealed.password)
      } finally {
        typing = false
      }
    },
    reopen() {
      misses = 0
      missesInAll = 0
      restUntil = 0
    }
  }
}

/** The Mac's unlock key. A phone pins the public half, so it must outlive a restart. */
export function loadUnlockKey(file: string): SealKeyPair {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SealKeyPair> | null
    if (typeof raw?.publicKey === 'string' && typeof raw.privateKey === 'string') return { publicKey: raw.publicKey, privateKey: raw.privateKey }
  } catch {
    // None yet, or unreadable: a new key means phones are asked to check it again.
  }
  const pair = generateSealKeyPair()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileAtomic(file, JSON.stringify(pair))
  chmodSync(file, 0o600)
  return pair
}
