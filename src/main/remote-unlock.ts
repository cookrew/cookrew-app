import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ViewerWho } from '../shared/remote-access'
import { UNLOCK_INFO, UNLOCK_PASSWORD_MAX, type UnlockAnswer, type UnlockBegin } from '../shared/remote-unlock'
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
const SETTLE_LOOKS = 15
const SETTLE_STEP_MS = 400

export interface UnlockDoorDeps {
  keyPair(): SealKeyPair
  /** Why this viewer may not unlock; null when it may. */
  refusal(who: ViewerWho): string | null
  /** A fresh read, never a cached one. */
  locked(): Promise<boolean>
  wake(): Promise<void>
  /** Types at the lock screen and presses Return. */
  type(password: string): Promise<void>
  record(outcome: string, who: ViewerWho): void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface UnlockDoor {
  begin(who: ViewerWho): Promise<UnlockBegin>
  unlock(who: ViewerWho, wire: string): Promise<UnlockAnswer>
}

const NOT_LOCKED = 'This Mac is not locked.'
const BUSY = 'An unlock is already under way.'
const REFUSED = 'That request could not be read. Try again.'

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
  let restUntil = 0
  let typing = false

  const restWords = (): string => `Too many tries. Try again in ${Math.max(1, Math.ceil((restUntil - now()) / 1000))} s.`
  const resting = (): boolean => now() < restUntil

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
    if (misses >= UNLOCK_ATTEMPTS) {
      misses = 0
      restUntil = now() + UNLOCK_REST_MS
    }
    deps.record('wrong password', who)
    return { ok: false, outcome: 'wrong', error: 'That password did not open this Mac.' }
  }

  const typeIt = async (who: ViewerWho, password: string): Promise<UnlockAnswer> => {
    typing = true
    try {
      await deps.wake()
      await deps.type(password)
      if (!(await opensUp())) return missed(who)
      misses = 0
      deps.record('unlocked', who)
      return { ok: true, outcome: 'unlocked' }
    } catch {
      deps.record('could not type', who)
      return { ok: false, outcome: 'failed', error: 'Could not type at the lock screen. Try again, or unlock it at the Mac.' }
    } finally {
      typing = false
    }
  }

  return {
    async begin(who) {
      const refusal = deps.refusal(who)
      if (refusal !== null) return { ok: false, error: refusal }
      if (typing) return { ok: false, outcome: 'busy', error: BUSY }
      if (resting()) return { ok: false, outcome: 'resting', error: restWords() }
      if (!(await deps.locked())) return { ok: false, outcome: 'not-locked', error: NOT_LOCKED }
      const value = randomBytes(32).toString('base64url')
      challenges.set(who.key, { value, until: now() + UNLOCK_CHALLENGE_MS })
      return { ok: true, key: deps.keyPair().publicKey, challenge: value }
    },
    async unlock(who, wire) {
      const refusal = deps.refusal(who)
      if (refusal !== null) return { ok: false, error: refusal }
      if (typing) return { ok: false, outcome: 'busy', error: BUSY }
      if (resting()) return { ok: false, outcome: 'resting', error: restWords() }
      const sealed = readSealed(openBody(deps.keyPair().privateKey, UNLOCK_INFO, wire))
      if (sealed === null || !spend(who, sealed.challenge)) {
        challenges.delete(who.key)
        return { ok: false, outcome: 'refused', error: REFUSED }
      }
      if (!(await deps.locked())) return { ok: false, outcome: 'not-locked', error: NOT_LOCKED }
      return typeIt(who, sealed.password)
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
