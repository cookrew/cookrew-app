import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { AccountResult } from '../shared/account-v2'
import type { ApprovalRequest } from '../shared/account-approvals'
import {
  badgeCount,
  eventNotice,
  keptAnswered,
  rowNotice,
  type AccountEvent,
  type AnsweredRow,
  type QueueRow,
  type RowAction,
} from '../shared/account-requests'

/**
 * THE ONE QUEUE, on the desktop (D11) — the poller D6's approvals queue grew
 * into.
 *
 * What waits here is a sign-in waiting for a nod: one poll, one badge, one
 * notification habit, one place it is answered. The registry's list once
 * carried two more kinds (a phone asking for Wi-Fi, a guest asking for a
 * seat); the pages that raised them are gone (0.6.0) and so are the rows.
 *
 * WHY POLLING, AND WHY THIS SLOWLY, is unchanged from the approvals queue it
 * replaces: twenty seconds against a registry whose requests wait minutes, and
 * window focus as the other trigger, because the moment a person comes back to
 * the window is the moment they can answer. A socket held open to cookrew.dev
 * on every desktop for a message most accounts never send is the alternative.
 *
 * WHAT IS ANNOUNCED, AND EXACTLY ONCE. A row that arrives is announced by the
 * ROW: it knows whether it is a sign-in or a guest, and can say so.
 * The account:changed feed announces everything ELSE that happened to the
 * account (a device joined elsewhere, one was revoked, the password changed, a
 * door moved, somebody pressed "not me"). The feed's own `request` kind is
 * therefore silent here: it is the same arrival the row already announced, and
 * two notifications for one thing is how people learn to ignore both.
 *
 * NOTHING HERE THROWS. It runs on a timer beside the canvas, so a registry
 * that is down or a session that died leaves the list as it was.
 */

/** Twenty seconds, stated once and exported so a test can assert the cadence. */
export const REQUESTS_POLL_MS = 20_000

/** The account calls this needs, narrowed so a test needs no registry. */
export interface RequestsCaller {
  call<T>(pathname: string, init?: RequestInit & { parse?: boolean }): Promise<AccountResult<T>>
  /** Optional, so a test's narrow caller stays narrow. */
  isPasswordless?(): boolean
  /** The alarm's proof, for an account with no password to send. */
  providerProve?(act: 'not-me'): Promise<AccountResult<string>>
  /**
   * The same call, answered as a Response.
   *
   * The number-matching rung (R3) is the reason: a wrong number comes back as
   * a body carrying how many tries are left, and a client that cannot read it
   * can only say "wrong" to somebody who then retypes until there is no rope
   * left. `call` flattens a refusal to a word, which is right for every other
   * route here and wrong for exactly this one.
   */
  authedResponse(
    pathname: string,
    init?: RequestInit,
  ): Promise<{ ok: true; response: Response } | { ok: false; reason: string }>
  account(): { username: string; deviceId: string } | null
  sessionLive(): boolean
}

/** Where the finished rows are kept. Injected so a test needs no homedir. */
export interface AnsweredStore {
  read(): AnsweredRow[]
  write(rows: readonly AnsweredRow[]): void
}

export interface RequestsDeps {
  accounts: RequestsCaller
  /** A system notification. Injected, so this module never sees Electron. */
  notify: (input: { title: string; body: string; requestId: string | null }) => void
  /** The list changed: main pushes the new count to the renderer. */
  onChange?: (pending: readonly QueueRow[]) => void
  /** Something happened to the account: the renderer raises a toast. */
  onEvent?: (event: AccountEvent, sentence: string) => void
  answered?: AnsweredStore
  now?: () => number
  pollMs?: number
}

/**
 * What answering one row came to.
 *
 * ONE REFUSAL SHAPE, with a count on the one refusal that has one. A union
 * keyed on a `reason` that is otherwise an open string cannot be narrowed by a
 * reader, so the count is optional and `reason === 'bad_match'` is the test —
 * which is also exactly what the wire looks like.
 */
export type DecideOutcome =
  | { ok: true }
  | { ok: false; reason: string; message?: string; triesLeft?: number }

/** The registry's own word for each button (V3-09's approvals, V3-11's queue). */
const REGISTRY_DECISION: Record<RowAction['id'], string> = {
  approve: 'approve',
  deny: 'deny',
  'not-me': 'not-me',
}

export const requestsHistoryFile = (base?: string): string =>
  path.join(base ?? path.join(homedir(), '.cookrew'), 'requests-history.json')

/**
 * The finished rows, on disk.
 *
 * ON DISK BECAUSE SEVEN DAYS OUTLIVES A RESTART (D11), and because every
 * sentence one of these rows says is first person: "approved here", "denied
 * here". The registry's queue lists what is still WAITING; the only thing
 * that knows this Mac answered is this Mac.
 *
 * A file that will not parse reads as EMPTY. The alternative — refusing to
 * start over a receipts list — would take the whole account surface down for a
 * record nobody is owed.
 */
export const answeredStoreIn = (base?: string): AnsweredStore => {
  const file = requestsHistoryFile(base)
  return {
    read: () => {
      try {
        if (!existsSync(file)) return []
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
        const rows = (parsed as { rows?: unknown }).rows
        return Array.isArray(rows) ? (rows.filter(isAnsweredRow) as AnsweredRow[]) : []
      } catch {
        return []
      }
    },
    write: (rows) => {
      try {
        mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
        const temp = `${file}.${process.pid}.tmp`
        writeFileSync(temp, `${JSON.stringify({ rows }, null, 2)}\n`, { mode: 0o600 })
        renameSync(temp, file)
      } catch {
        // A receipt that could not be written is not worth a failed answer:
        // the request WAS answered, and the row is the smallest part of that.
      }
    },
  }
}

const isAnsweredRow = (value: unknown): value is AnsweredRow => {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    row.kind === 'join' &&
    (row.outcome === 'joined' || row.outcome === 'denied') &&
    typeof row.subject === 'string' &&
    typeof row.at === 'number'
  )
}

/**
 * A row off the wire, or null. A stranger's registry is still a stranger, and
 * a kind this build has no row for is not listed, counted or announced.
 */
const asQueueRow = (value: unknown): QueueRow | null => {
  if (typeof value !== 'object' || value === null) return null
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id.length === 0) return null
  if (row.kind !== 'join') return null
  if (typeof row.at !== 'number' || typeof row.expiresAt !== 'number') return null
  const text = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 && v.length <= 256 ? v : undefined
  return {
    id: row.id,
    kind: row.kind,
    ...(text(row.device) === undefined ? {} : { device: text(row.device) as string }),
    address: text(row.address) ?? '',
    at: row.at,
    expiresAt: row.expiresAt,
    state: text(row.state) ?? 'pending',
  }
}

const asEvent = (value: unknown): AccountEvent | null => {
  if (typeof value !== 'object' || value === null) return null
  const event = value as Record<string, unknown>
  const kinds = ['joined', 'revoked', 'password-changed', 'door-moved', 'not-me', 'request']
  if (typeof event.seq !== 'number' || typeof event.at !== 'number') return null
  if (typeof event.kind !== 'string' || !kinds.includes(event.kind)) return null
  return {
    seq: event.seq,
    kind: event.kind as AccountEvent['kind'],
    ...(typeof event.device === 'string' ? { device: event.device } : {}),
    ...(typeof event.address === 'string' ? { address: event.address } : {}),
    at: event.at,
  }
}

export class Requests {
  private readonly deps: RequestsDeps
  private readonly now: () => number
  private readonly pollMs: number
  private pending: readonly QueueRow[] = []
  private answered: readonly AnsweredRow[] = []
  /** Ids already announced, pruned to what is still waiting. */
  private announced: ReadonlySet<string> = new Set()
  /** How far this Mac has read the account:changed feed. */
  private cursor = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private inFlight = false

  constructor(deps: RequestsDeps) {
    this.deps = deps
    this.now = deps.now ?? ((): number => Date.now())
    this.pollMs = deps.pollMs ?? REQUESTS_POLL_MS
    this.answered = keptAnswered(deps.answered?.read() ?? [], this.now())
  }

  /** What is waiting, newest last, as the card lists it. */
  list(): readonly QueueRow[] {
    return this.pending
  }

  /** What is over, inside its seven days. */
  history(): readonly AnsweredRow[] {
    return keptAnswered(this.answered, this.now())
  }

  /** What the avatar's badge shows (D1): every kind. */
  get count(): number {
    return badgeCount(this.pending)
  }

  /**
   * The join rows, in the shape the lock screen already reads.
   *
   * D13 names who is waiting to JOIN: a device at the door, which is what a
   * lock can say something about.
   */
  joinRequests(): readonly ApprovalRequest[] {
    return this.pending
      .filter((row) => row.kind === 'join')
      .map((row) => ({
        id: row.id,
        deviceName: row.device ?? '',
        kind: 'desktop' as const,
        address: row.address,
        at: row.at,
        expiresAt: row.expiresAt,
      }))
  }

  /**
   * START OR STOP, BY WHETHER THERE IS AN ACCOUNT TO ASK FOR (V3-UI1 F1).
   *
   * The caller used to decide this once, at module load, with
   * `if (accounts.account()) requests.start()`. On a first run there is no
   * account at that moment, so the poll never started; the person claimed one
   * a minute later and nothing ever asked. The only other thing that refreshed
   * was window focus — precisely the event somebody already looking at their
   * canvas does not produce — so the one rung an account without a second
   * factor has was a door nobody knew was knocking.
   *
   * The rule lives here, beside start and stop, and is called at boot AND from
   * `accounts.onChange`, so it follows the account rather than the order the
   * module happened to load in.
   */
  follow(): void {
    if (this.deps.accounts.account() === null) {
      this.stop()
      // The badge goes with the account. A Mac that signed out still showing
      // "1 device waiting" points at a card it cannot open.
      if (this.pending.length > 0) this.settle([])
      return
    }
    this.start()
  }

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
   * Ask once — the queue, then what changed.
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
      const queue = await this.deps.accounts.call<unknown>('/v2/me/requests')
      // A REFUSAL LEAVES THE LIST ALONE. Clearing it because cookrew.dev
      // hiccuped would drop a request the owner was about to answer.
      if (queue.ok && Array.isArray(queue.value)) {
        this.settle(queue.value.map(asQueueRow).filter((row): row is QueueRow => row !== null))
      }
      await this.readEvents()
    } catch {
      // A poll that throws is a poll that did not happen.
    } finally {
      this.inFlight = false
    }
  }

  /** The account:changed feed, from where this Mac left off. */
  private async readEvents(): Promise<void> {
    const feed = await this.deps.accounts.call<unknown>(`/v2/me/events?since=${this.cursor}`)
    if (!feed.ok || typeof feed.value !== 'object' || feed.value === null) return
    const body = feed.value as { events?: unknown; cursor?: unknown }
    if (typeof body.cursor === 'number') this.cursor = body.cursor
    if (!Array.isArray(body.events)) return
    const username = this.deps.accounts.account()?.username ?? ''
    for (const raw of body.events) {
      const event = asEvent(raw)
      // `request` is the arrival a ROW announces, with the kind in its
      // sentence. Saying it twice in two vaguer words is how both get ignored.
      if (event === null || event.kind === 'request') continue
      const body = eventNotice(event, username)
      this.deps.notify({ title: 'Cookrew', body, requestId: null })
      this.deps.onEvent?.(event, body)
    }
  }

  /**
   * ANSWER ONE ROW.
   *
   * The verb is the BUTTON's own id, so the card and this cannot disagree
   * about what a press meant. A sign-in is answered on the approvals route,
   * where the number-matching rung lives; nothing else is answered here.
   */
  async decide(id: string, action: RowAction['id'], match?: string): Promise<DecideOutcome> {
    const row = this.pending.find((candidate) => candidate.id === id)
    if (row === undefined) return { ok: false, reason: 'not_found' }
    const outcome = await this.answerJoin(row, action, match)
    if (outcome.ok) {
      this.record(row, action)
      await this.refresh()
    }
    return outcome
  }

  /**
   * A sign-in, on the approvals route (V3-09).
   *
   * APPROVE CARRIES THE NUMBER and the two safe answers do not. A wrong number
   * comes back with how much rope is left; the third miss ends the sign-in at
   * the registry, and the next poll simply finds the row gone.
   */
  private async answerJoin(row: QueueRow, action: RowAction['id'], match?: string): Promise<DecideOutcome> {
    if (action !== 'approve' && action !== 'deny' && action !== 'not-me') {
      return { ok: false, reason: 'unknown' }
    }
    const body: Record<string, unknown> = { decision: REGISTRY_DECISION[action] }
    if (action === 'approve') body.match = match ?? ''
    // The alarm steps up, and an account with no password proves it at its
    // provider. A person pressing NOT ME must not be told to type one.
    const prove = this.deps.accounts.providerProve
    if (action === 'not-me' && prove !== undefined && this.deps.accounts.isPasswordless?.() === true) {
      const proved = await prove.call(this.deps.accounts, 'not-me')
      if (!proved.ok) return { ok: false, reason: proved.reason }
      body.stepUp = proved.value
    }
    const sent = await this.deps.accounts.authedResponse(
      `/v2/me/approvals/${encodeURIComponent(row.id)}`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    if (!sent.ok) return { ok: false, reason: sent.reason }
    if (sent.response.status === 204) return { ok: true }
    type Refusal = { error?: unknown; message?: unknown; triesLeft?: unknown }
    let answered: Refusal | null = null
    try {
      answered = (await sent.response.json()) as Refusal
    } catch {
      // A refusal with no readable body is still a refusal; it just has no
      // count to show, and pretending otherwise would put a 0 on screen.
      answered = null
    }
    if (answered?.error === 'bad_match') {
      return {
        ok: false,
        reason: 'bad_match',
        triesLeft: typeof answered.triesLeft === 'number' ? answered.triesLeft : 0,
      }
    }
    return {
      ok: false,
      reason: typeof answered?.error === 'string' ? answered.error : 'unknown',
      ...(typeof answered?.message === 'string' ? { message: answered.message } : {}),
    }
  }

  /**
   * Keep what this Mac just did, for seven days.
   *
   * ONLY THIS MAC'S OWN ANSWERS are kept, and that is the whole reason the
   * sentences can be first person. A device that joined by a code typed on
   * somebody else's Mac is announced by the feed and is not a receipt this
   * machine may claim — "approved here" would be a small lie on the one screen
   * that exists to be believed.
   */
  private record(row: QueueRow, action: RowAction['id']): void {
    const outcome: AnsweredRow['outcome'] = action === 'approve' ? 'joined' : 'denied'
    const kept: AnsweredRow = {
      id: row.id,
      kind: row.kind,
      outcome,
      subject: row.device ?? '',
      at: this.now(),
    }
    this.answered = keptAnswered([kept, ...this.answered], this.now())
    this.deps.answered?.write(this.answered)
  }

  /** Adopt a list, announce what is new in it, and tell main it changed. */
  private settle(next: readonly QueueRow[]): void {
    const changed =
      next.length !== this.pending.length ||
      next.some((row, index) => row.id !== this.pending[index]?.id)
    const fresh = next.filter((row) => !this.announced.has(row.id))
    this.pending = next
    this.announced = new Set(next.map((row) => row.id))
    // The badge first: a box that cannot show a notification still shows the count.
    if (changed) this.deps.onChange?.(next)
    const username = this.deps.accounts.account()?.username ?? ''
    for (const row of fresh) {
      this.deps.notify({ title: 'Cookrew', body: rowNotice(row, username), requestId: row.id })
    }
  }
}
