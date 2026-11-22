import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ViewerWho } from '../shared/remote-access'
import { REMEMBER_INFO, UNLOCK_INFO, UNLOCK_PASSWORD_MAX, type UnlockAnswer, type UnlockBegin, type UnlockOutcome, type UnlockRoad } from '../shared/remote-unlock'
import { generateSealKeyPair, openBody, type SealKeyPair } from '../shared/relay-seal'
import { writeFileAtomic } from './atomic-file'
import type { RememberedUnlocks } from './unlock-remembered'

/**
 * THE MAC'S SIDE OF A REMOTE UNLOCK.
 *
 * The password exists here for as long as it takes to type it. It is not stored,
 * logged or echoed: a refusal never repeats what was sent, and the record names
 * who asked and how it went. The desk's own rules (the switch, Stop, Accessibility)
 * are asked twice, because Stop can land between the challenge and the typing.
 *
 * Attempts are counted for the machine, not the device: macOS counts them that way.
 *
 * REMEMBER (on the console, inside cookrew-seal/2 only): a page that asks to remember a
 * password that worked gets an id (unlock-remembered.ts), and keeps a box sealed to this
 * Mac's unlock key holding the password and that id (REMEMBER_INFO). It later sends the box
 * in place of the password. The box is taken only on a v2 road, only while the id is held
 * for the same device; otherwise "forgotten", and nothing is typed.
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
  /** Shut until someone at the Mac reopens it. */
  closed?(): void
  /** The running count of wrong passwords: a restart must not forgive them. */
  misses?: { read(): number; write(count: number): void }
  wake(): Promise<void>
  /** Every character has a key. Absent: assumed. */
  typable?(password: string): boolean
  /** Types at the lock screen and presses Return. */
  type(password: string): Promise<void>
  record(outcome: string, who: ViewerWho): void
  /** Remembered passwords' ids. Absent: this Mac remembers nothing for a page. */
  remembered?: RememberedUnlocks
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface UnlockDoor {
  begin(who: ViewerWho, road?: UnlockRoad): Promise<UnlockBegin>
  unlock(who: ViewerWho, wire: string, road?: UnlockRoad): Promise<UnlockAnswer>
  /** The page's own Forget: its remembered id goes, inside v2 and for its own device only. */
  forget(who: ViewerWho, id: unknown, road?: UnlockRoad): boolean
  /** Someone at the Mac turned remote control on. */
  reopen(): void
}

const NOT_LOCKED = 'This Mac is not locked.'
const BUSY = 'An unlock is already under way.'
const REFUSED = 'That request could not be read. Try again.'
const UNTYPABLE = 'This password cannot be typed from here: it has a character no key makes. Unlock it at the Mac.'
const CLOSED = 'Too many wrong passwords. Turn remote control off and on at the Mac to try again.'
const FORGOTTEN = 'This Mac no longer takes the password this device remembered. Type it again.'
/** What a Forget the Mac could not write answers: a fixed sentence, never the file system's (it names paths). */
export const FORGET_FAILED = 'This Mac could not forget that password just now. Try again, or rotate the pairing at the Mac.'

const isPassword = (p: unknown): p is string => typeof p === 'string' && p.length > 0 && p.length <= UNLOCK_PASSWORD_MAX

const parsed = (opened: string | null): Record<string, unknown> | null => {
  if (opened === null) return null
  try {
    const raw = JSON.parse(opened) as unknown
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** A typed password, or a remembered box: exactly one of the two. */
type Asked = { readonly challenge: string; readonly password: string; readonly remember: boolean } | { readonly challenge: string; readonly box: string }

const readSealed = (opened: string | null): Asked | null => {
  const raw = parsed(opened)
  if (raw === null || typeof raw.c !== 'string') return null
  if (raw.p !== undefined && raw.b !== undefined) return null
  if (typeof raw.b === 'string') return { challenge: raw.c, box: raw.b }
  return isPassword(raw.p) ? { challenge: raw.c, password: raw.p, remember: raw.m === 1 } : null
}

/** A remembered password's box: the password and its id, under the remember label only. */
const readBox = (opened: string | null): { password: string; id: string } | null => {
  const raw = parsed(opened)
  return raw !== null && isPassword(raw.p) && typeof raw.r === 'string' ? { password: raw.p, id: raw.r } : null
}

/**
 * A plain file on purpose: this is against a lost phone, which cannot edit it. An agent
 * that can edit it can already delete the switch, which ends remote unlock altogether.
 */
export function unlockMissesFile(file: string): { read(): number; write(count: number): void } {
  return {
    read: () => Number(readFileSync(file, 'utf8')),
    write: (count) => writeFileAtomic(file, String(count))
  }
}

export function createUnlockDoor(deps: UnlockDoorDeps): UnlockDoor {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const challenges = new Map<string, { value: string; until: number }>()
  let misses = 0
  let missesInAll = readMisses()
  let restUntil = 0
  let typing = false

  function readMisses(): number {
    try {
      const held = deps.misses?.read() ?? 0
      return Number.isInteger(held) && held > 0 ? held : 0
    } catch {
      return 0
    }
  }

  const keepMisses = (): void => {
    try {
      deps.misses?.write(missesInAll)
    } catch {
      // Held in memory for this run.
    }
  }

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
    keepMisses()
    if (missesInAll === UNLOCK_MISSES_MAX) deps.closed?.()
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
      keepMisses()
      deps.record('unlocked', who)
      return { ok: true, outcome: 'unlocked' }
    } catch {
      // The hand stops when the lock goes: someone at the Mac got there first.
      if (!(await deps.locked().catch(() => true))) return { ok: false, outcome: 'not-locked', error: NOT_LOCKED }
      deps.record('could not type', who)
      return { ok: false, outcome: 'failed', error: 'Could not type at the lock screen. Try again, or unlock it at the Mac.' }
    }
  }

  /** Remembering works on a v2 road only, and only with a store of ids. */
  const remembers = (road: UnlockRoad | undefined): RememberedUnlocks | null => (road?.sealedV2 === true ? (deps.remembered ?? null) : null)

  /** The password to type: the one sent, or the one in a live box; else the answer that stops here. */
  const passwordOf = (who: ViewerWho, asked: Asked, road: UnlockRoad | undefined): { password: string; id: string | null } | UnlockAnswer => {
    if (!('box' in asked)) return { password: asked.password, id: null }
    const held = remembers(road)
    if (held === null) return { ok: false, outcome: 'refused', error: REFUSED }
    const box = readBox(openBody(deps.keyPair().privateKey, REMEMBER_INFO, asked.box))
    if (box === null) return { ok: false, outcome: 'refused', error: REFUSED }
    if (!held.live(box.id, who.key)) {
      deps.record('a remembered password this Mac no longer takes', who)
      return { ok: false, outcome: 'forgotten', error: FORGOTTEN }
    }
    return box
  }

  /** A wrong password is the answer whatever happens here: an id that cannot be dropped is said in the record only. */
  const dropQuietly = (id: string, who: ViewerWho): void => {
    try {
      deps.remembered?.drop(id, who.key)
    } catch {
      deps.record('a remembered password stopped working and could not be taken back', who)
    }
  }

  /** The Mac is open whatever happens here: an id that cannot be kept is an unlock with nothing remembered. */
  const issued = (held: RememberedUnlocks, who: ViewerWho): { remembered?: string } => {
    try {
      return { remembered: held.issue(who.key) }
    } catch {
      deps.record('unlocked; the password could not be remembered', who)
      return {}
    }
  }

  return {
    async begin(who, road) {
      const stop = stopped(who)
      if (stop !== null) return stop
      if (!(await deps.locked())) return { ok: false, outcome: 'not-locked', error: NOT_LOCKED }
      const value = randomBytes(32).toString('base64url')
      challenges.set(who.key, { value, until: now() + UNLOCK_CHALLENGE_MS })
      return { ok: true, key: deps.keyPair().publicKey, challenge: value, ...(remembers(road) ? { remember: 1 as const } : {}) }
    },
    async unlock(who, wire, road) {
      const stop = stopped(who)
      if (stop !== null) return stop
      const sealed = readSealed(openBody(deps.keyPair().privateKey, UNLOCK_INFO, wire))
      if (sealed === null || !spend(who, sealed.challenge)) {
        challenges.delete(who.key)
        return { ok: false, outcome: 'refused', error: REFUSED }
      }
      const found = passwordOf(who, sealed, road)
      if ('ok' in found) return found
      if (deps.typable && !deps.typable(found.password)) return { ok: false, outcome: 'failed', error: UNTYPABLE }
      // Before the first await: two devices must not both get past this line.
      typing = true
      try {
        if (!(await deps.locked())) return { ok: false, outcome: 'not-locked', error: NOT_LOCKED }
        const answer = await typeIt(who, found.password)
        // A remembered password that stopped working is taken back: the page drops its box too.
        if (!answer.ok && answer.outcome === 'wrong' && found.id !== null) dropQuietly(found.id, who)
        const held = remembers(road)
        // A new id only for a typed password the page asked to remember; a box keeps the id it holds.
        if (answer.ok && held !== null && !('box' in sealed) && sealed.remember) return { ...answer, ...issued(held, who) }
        return answer
      } finally {
        typing = false
      }
    },
    forget(who, id, road) {
      const held = remembers(road)
      if (held === null || typeof id !== 'string') return false
      try {
        return held.drop(id, who.key)
      } catch {
        deps.record('a remembered password could not be forgotten', who)
        throw new Error(FORGET_FAILED)
      }
    },
    reopen() {
      misses = 0
      missesInAll = 0
      restUntil = 0
      keepMisses()
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
