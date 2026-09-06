/**
 * THE IDLE LOCK — the owner's view, and nothing else.
 *
 * On by default at fifteen minutes (ruling 2026-09-06), switchable off. What
 * it covers is stated narrowly on purpose: THE OWNER'S RENDERER. Agents keep
 * running underneath, served doors keep answering, the phone keeps its
 * session. A lock that stopped the work would be a lock nobody leaves on, and
 * a setting people turn off protects nothing.
 *
 * The password is checked OFFLINE, against the local verifier in account.json
 * (account-v2.ts). A lock that needed cookrew.dev would fail closed on a
 * plane — which is precisely where a laptop is most worth locking.
 *
 * NO TIMER OF ITS OWN. Idleness is a question about a clock, so this is a
 * state machine driven by `tick()` and fed by activity pings from the
 * renderer and by window focus. Main owns the interval; a test owns the
 * clock, and neither has to wait fifteen real minutes to know it works.
 */

/** Five wrong tries, then a minute's pause — the sentence in D5 says so. */
export const MAX_TRIES = 5
export const PAUSE_MS = 60_000

export interface LockDeps {
  /** How long idle before locking. 0 means off. */
  lockAfterMs: number
  /** The offline check. Returns false when there is no account at all. */
  verify: (password: string) => boolean
  now?: () => number
  /** Told on every change of `locked`, so main can broadcast to the owner. */
  onChange?: (locked: boolean) => void
}

export type UnlockOutcome =
  | { ok: true }
  | { ok: false; reason: 'wrong'; triesLeft: number }
  | { ok: false; reason: 'paused'; pausedForMs: number }
  | { ok: false; reason: 'no-account' }

export class IdleLock {
  private readonly verify: (password: string) => boolean
  private readonly now: () => number
  private readonly onChange: ((locked: boolean) => void) | undefined
  private lockAfter: number
  private lastActive: number
  private isLocked = false
  private wrongTries = 0
  private pausedUntil = 0

  constructor(deps: LockDeps) {
    this.verify = deps.verify
    this.now = deps.now ?? (() => Date.now())
    this.onChange = deps.onChange
    this.lockAfter = deps.lockAfterMs
    this.lastActive = this.now()
  }

  get locked(): boolean {
    return this.isLocked
  }

  get lockAfterMs(): number {
    return this.lockAfter
  }

  private set(locked: boolean): void {
    if (this.isLocked === locked) return
    this.isLocked = locked
    this.onChange?.(locked)
  }

  /**
   * The renderer says a person is there.
   *
   * Ignored while LOCKED, and that is the whole point: the lock screen is a
   * live React tree that types, clicks and moves the mouse, so an activity
   * ping from it would keep pushing the deadline out and the app would unlock
   * itself by being looked at.
   */
  activity(at?: number): void {
    if (this.isLocked) return
    this.lastActive = at ?? this.now()
  }

  /** Window focus counts as presence, for the same reason a keystroke does. */
  focus(at?: number): void {
    this.activity(at)
  }

  /** Lock now — the menu item, and what `tick` calls when the idle runs out. */
  lock(): void {
    this.set(true)
  }

  /**
   * Has it been idle long enough? Called on an interval by main.
   *
   * Off (0) never locks, and never re-arms on its own either: turning the
   * setting off is a decision, not a snooze.
   */
  tick(at?: number): boolean {
    const now = at ?? this.now()
    if (this.isLocked || this.lockAfter <= 0) return this.isLocked
    if (now - this.lastActive >= this.lockAfter) this.set(true)
    return this.isLocked
  }

  /**
   * The password, offline.
   *
   * The pause is on WRONG ANSWERS, not on the clock: five tries buys a minute,
   * so a guesser gets twelve attempts an hour while the owner who fat-fingered
   * their password twice notices nothing. A right answer clears the count —
   * the counter exists to slow an attacker, not to punish a typo.
   */
  unlock(password: string): UnlockOutcome {
    const now = this.now()
    if (now < this.pausedUntil) {
      return { ok: false, reason: 'paused', pausedForMs: this.pausedUntil - now }
    }
    if (this.verify(password)) {
      this.wrongTries = 0
      this.pausedUntil = 0
      this.lastActive = now
      this.set(false)
      return { ok: true }
    }
    this.wrongTries += 1
    if (this.wrongTries >= MAX_TRIES) {
      this.wrongTries = 0
      this.pausedUntil = now + PAUSE_MS
      return { ok: false, reason: 'paused', pausedForMs: PAUSE_MS }
    }
    return { ok: false, reason: 'wrong', triesLeft: MAX_TRIES - this.wrongTries }
  }

  /**
   * OPENED BY PROOF, not by a password typed at this screen.
   *
   * cookrew.dev has just completed a sign-in for this account: the password,
   * and — where the account asks for one — a second factor as well. That is
   * strictly MORE than this lock asks for, and `resume` has already re-derived
   * the file's verifier from the same password. Staying shut would lock the
   * owner out by the weaker check in the moment they passed the stronger one.
   *
   * Nothing was guessed here, so it never spends a try and never pauses.
   */
  proven(): void {
    this.wrongTries = 0
    this.pausedUntil = 0
    this.lastActive = this.now()
    this.set(false)
  }

  /**
   * Change the setting.
   *
   * Turning it OFF unlocks: leaving a locked screen behind a switch that says
   * "off" is a state whose own UI denies it exists. Turning it on restarts the
   * idle clock rather than locking immediately — the owner is plainly present,
   * they just used the setting.
   */
  setLockAfterMs(ms: number): number {
    this.lockAfter = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0
    this.lastActive = this.now()
    if (this.lockAfter === 0) this.set(false)
    return this.lockAfter
  }
}
