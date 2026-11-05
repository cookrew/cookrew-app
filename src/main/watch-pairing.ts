// THE WATCH'S OWN CREDENTIAL.
//
// An Apple Watch is the device most likely to be left on a bench, and the
// pairing token opens every terminal on this Mac. So a watch never holds it:
// it holds a token of its own that opens only what the wrist needs
// (watch-routes.ts · watchRouteAllowed), and forgetting the watch ends that
// token and nothing else. What it does open is still real: it speaks to the
// agents, and they act. It reaches no shell, no raw keys and no workspace, but
// it is not a read-only token, and on a plain-HTTP address (the LAN, like a
// phone there) it crosses that network in the clear.
//
// It is claimed with six digits, because six digits is what a wrist can type.
// That is safe only because the code is short-lived (five minutes), single
// use, burned after five wrong guesses, and every failed claim from anyone
// counts toward a pause: a million-space code cannot be walked at these rates.
//
// A watch away from home has no address to type and no way in but the account.
// So the join code that lets it into the account is also what claims it here:
// the Mac arms the code it had minted (arm), and the watch brings the same eight
// characters down the relay. Same rules, longer life: the registry's ten minutes.
//
// One watch at a time: a new claim replaces the old token.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export const WATCH_CODE_TTL_MS = 5 * 60 * 1000
export const WATCH_CODE_GUESSES = 5
/** Failed claims from anyone, inside the window, that pause claiming for everyone. */
export const WATCH_FAILS_BEFORE_PAUSE = 20
export const WATCH_FAIL_WINDOW_MS = 60 * 1000
export const WATCH_PAUSE_MS = 60 * 1000

export type WatchClaim =
  | { readonly ok: true; readonly token: string }
  | { readonly ok: false; readonly reason: 'no-code' | 'wrong' | 'expired' | 'burned' | 'paused' }

export interface WatchPairingOptions {
  /** Where the token lives; absent, ~/.cookrew/watch-token. */
  readonly file?: string
  readonly now?: () => number
}

interface LiveCode {
  readonly code: string
  readonly expiresAt: number
  readonly guesses: number
}

const same = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * What a Mac says to prove it holds a watch's token, without sending it. A watch
 * that roams remembers a plain-HTTP address that may be somebody else's machine
 * on the next network, so it asks this first and carries its token only to an
 * address that answers right. Byte for byte with the watch (Session.swift).
 */
export const watchProof = (token: string, nonce: string): string =>
  createHmac('sha256', token).update(`cookrew-watch-hello/1 ${nonce}`).digest('base64url')

/** A code as a person types it, as a code is kept: one case, no separators. */
const plainCode = (code: string): string => code.replace(/[\s-]/g, '').toUpperCase()

export class WatchPairing {
  private readonly file: string
  private readonly now: () => number
  private token: string | null
  private live: LiveCode | null = null
  private fails: readonly number[] = []
  private pausedUntil = 0
  private claimed = 0

  constructor(options: WatchPairingOptions = {}) {
    this.file = options.file ?? path.join(homedir(), '.cookrew', 'watch-token')
    this.now = options.now ?? Date.now
    this.token = this.read()
  }

  private read(): string | null {
    try {
      if (!existsSync(this.file)) return null
      const token = readFileSync(this.file, 'utf8').trim()
      return token.length >= 16 ? token : null
    } catch (error) {
      console.error('Reading the watch token failed; the watch must pair again:', error)
      return null
    }
  }

  private write(token: string): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      writeFileSync(this.file, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
      chmodSync(this.file, 0o600)
    } catch (error) {
      console.error('Writing the watch token failed (it lasts until this app quits):', error)
    }
  }

  get paired(): boolean {
    return this.token !== null
  }

  /** Watches that have arrived since this app started: how a sheet tells one arrived from a code going away. */
  get claims(): number {
    return this.claimed
  }

  /** The proof for this nonce, or null with no watch paired. */
  proof(nonce: string): string | null {
    return this.token === null ? null : watchProof(this.token, nonce)
  }

  accepts(candidate: string | null | undefined): boolean {
    return !!candidate && this.token !== null && same(candidate, this.token)
  }

  /** A fresh code, which replaces any code still standing. */
  mintCode(): { code: string; expiresAt: number } {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = this.now() + WATCH_CODE_TTL_MS
    this.live = { code, expiresAt, guesses: 0 }
    return { code, expiresAt }
  }

  /** A join code this Mac had minted, on offer as a claim until the registry's own end for it. */
  arm(code: string, expiresAt: number): void {
    this.live = { code: plainCode(code), expiresAt, guesses: 0 }
  }

  /** The code on offer: when it ends, never what it is. */
  pending(): { expiresAt: number } | null {
    return this.live && this.live.expiresAt > this.now() ? { expiresAt: this.live.expiresAt } : null
  }

  private failed(reason: 'no-code' | 'wrong' | 'expired' | 'burned'): WatchClaim {
    const now = this.now()
    this.fails = [...this.fails.filter((at) => now - at < WATCH_FAIL_WINDOW_MS), now]
    if (this.fails.length >= WATCH_FAILS_BEFORE_PAUSE) {
      this.pausedUntil = now + WATCH_PAUSE_MS
      this.fails = []
    }
    return { ok: false, reason }
  }

  claim(code: unknown): WatchClaim {
    const now = this.now()
    if (now < this.pausedUntil) return { ok: false, reason: 'paused' }
    const live = this.live
    if (!live) return this.failed('no-code')
    if (live.expiresAt <= now) {
      this.live = null
      return this.failed('expired')
    }
    if (typeof code !== 'string' || !same(plainCode(code), live.code)) {
      const guesses = live.guesses + 1
      if (guesses >= WATCH_CODE_GUESSES) {
        this.live = null
        return this.failed('burned')
      }
      this.live = { ...live, guesses }
      return this.failed('wrong')
    }
    this.live = null
    const token = randomBytes(24).toString('base64url')
    this.token = token
    this.claimed += 1
    this.write(token)
    return { ok: true, token }
  }

  /** Forget the watch: its token stops working here and now. */
  unpair(): void {
    this.token = null
    this.live = null
    try {
      rmSync(this.file, { force: true })
    } catch (error) {
      console.error('Removing the watch token failed:', error)
    }
  }
}
