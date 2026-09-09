import type { AccountResult } from '../shared/account-v2'
import {
  approvalSentence,
  type ApprovalDecision,
  type ApprovalRequest,
} from '../shared/account-approvals'

/**
 * THE APPROVAL QUEUE (D6) — the desktop is the thing that says yes.
 *
 * Until an account has a second factor, a new device signing in needs THIS
 * Mac's approval (D3's sentence promises exactly that), so the count of
 * waiting requests is the one piece of account state that changes without the
 * owner doing anything. Which means it has to be pulled.
 *
 * WHY POLLING, AND WHY THIS SLOWLY. Twenty seconds is chosen against the
 * registry's own expiry (a request waits minutes, not seconds) and against
 * the alternative: a socket held open to cookrew.dev for the whole life of
 * the app, on every desktop, to carry a message most accounts will never
 * send. Focus is the other trigger, because the moment a person comes back to
 * the window is the moment they are able to answer — and it makes the common
 * case ("I am at my Mac, I just pressed sign in on my phone") feel immediate
 * without shortening the interval for everyone.
 *
 * A NOTIFICATION FIRES ONCE PER REQUEST, and it is a NOTIFICATION — never a
 * modal over the canvas. The design is explicit that this lives in the
 * avatar's badge and in the OS; a dialog that steals the keyboard from a
 * person mid-sentence is how an approval prompt gets clicked through blind,
 * which is the one outcome that makes the whole ladder worthless.
 *
 * NOTHING HERE THROWS. It runs on a timer beside the canvas, so a registry
 * that is down or a session that died leaves the list as it was and the app
 * as it was.
 */

/** Twenty seconds, stated once and exported so the test can assert cadence. */
export const APPROVAL_POLL_MS = 20_000

/** The one thing this module needs from `Accounts`: an authenticated call. */
export interface ApprovalsCaller {
  call<T>(pathname: string, init?: RequestInit & { parse?: boolean }): Promise<AccountResult<T>>
  account(): { username: string } | null
  sessionLive(): boolean
}

export interface ApprovalsDeps {
  accounts: ApprovalsCaller
  /**
   * Show a system notification. Injected rather than imported so this module
   * never sees Electron — a test asserts the sentence, not a native toast.
   */
  notify: (input: { title: string; body: string; request: ApprovalRequest }) => void
  /** Told whenever the list changes, so main can push the new count. */
  onChange?: (requests: readonly ApprovalRequest[]) => void
  /** Does the account have a second factor? Only the SENTENCE depends on it. */
  hasSecondFactor?: () => boolean
  now?: () => number
  pollMs?: number
}

export class Approvals {
  private readonly deps: ApprovalsDeps
  private readonly now: () => number
  private readonly pollMs: number
  private requests: readonly ApprovalRequest[] = []
  /** Ids already announced, pruned to what is still waiting. */
  private announced: ReadonlySet<string> = new Set()
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false

  constructor(deps: ApprovalsDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.pollMs = deps.pollMs ?? APPROVAL_POLL_MS
  }

  /** The waiting requests, newest last, as the sheet lists them. */
  list(): readonly ApprovalRequest[] {
    return this.requests
  }

  /** What the avatar's rose badge shows (D1). */
  get count(): number {
    return this.requests.length
  }

  /** Begin polling. Safe to call twice; the second call is a no-op. */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => void this.refresh(), this.pollMs)
    this.timer.unref?.()
    void this.refresh()
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Ask once.
   *
   * A local-only desktop and a dead session are both answered WITHOUT a
   * socket: there is nobody to ask, and the badge must go to zero rather than
   * keep showing a request the owner can no longer act on.
   */
  async refresh(): Promise<void> {
    if (this.inFlight) return
    if (this.deps.accounts.account() === null || !this.deps.accounts.sessionLive()) {
      this.settle([])
      return
    }
    this.inFlight = true
    try {
      const result = await this.deps.accounts.call<readonly ApprovalRequest[]>('/v2/me/approvals')
      // A REFUSAL LEAVES THE LIST ALONE. Clearing it because cookrew.dev
      // hiccuped would drop a request the owner was about to answer.
      if (result.ok && Array.isArray(result.value)) this.settle(result.value)
    } catch {
      // Nothing: a poll that throws is a poll that did not happen.
    } finally {
      this.inFlight = false
    }
  }

  /**
   * Answer one.
   *
   * The list is refreshed after the registry answers rather than edited
   * locally, because "not me" changes more than this one row: it ends every
   * other session, which cancels every other waiting request too.
   */
  async decide(id: string, decision: ApprovalDecision): Promise<AccountResult<void>> {
    if (id.length === 0) return { ok: false, reason: 'unknown' }
    const result = await this.deps.accounts.call<void>(
      `/v2/me/approvals/${encodeURIComponent(id)}`,
      { method: 'POST', body: JSON.stringify({ decision }), parse: false },
    )
    if (!result.ok) return result
    await this.refresh()
    return { ok: true, value: undefined }
  }

  /** Adopt a list, announce what is new in it, and tell main it changed. */
  private settle(next: readonly ApprovalRequest[]): void {
    const changed =
      next.length !== this.requests.length ||
      next.some((request, index) => request.id !== this.requests[index]?.id)
    const fresh = next.filter((request) => !this.announced.has(request.id))
    this.requests = next
    this.announced = new Set(next.map((request) => request.id))
    const username = this.deps.accounts.account()?.username ?? ''
    for (const request of fresh) {
      this.deps.notify({
        title: 'Cookrew',
        body: approvalSentence(request, {
          username,
          hasSecondFactor: this.deps.hasSecondFactor?.() ?? false,
          now: this.now(),
        }),
        request,
      })
    }
    if (changed) this.deps.onChange?.(next)
  }
}
