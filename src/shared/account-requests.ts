import { accountCopy } from './account-copy'
import { startedAgo } from './account-approvals'

/**
 * THE ONE QUEUE (D11) — one shape for three kinds, and every decision about
 * how a row reads made HERE, where it can be tested without a window.
 *
 * D11 replaces D6. A sign-in waiting for a nod, a phone asking for this Mac's
 * Wi-Fi and a guest asking for a seat were three surfaces in three places; the
 * design makes them three ROWS of one card, so the owner has one habit and one
 * destination — the avatar's badge, the notification, and this list all land
 * in the same place.
 *
 * WHY THE VIEW MODEL IS SHARED AND NOT IN THE COMPONENT. Two processes say
 * these sentences: main writes them into a system notification, the tab draws
 * them in a row. account-approvals.ts is here for exactly that reason and this
 * is the same rule one queue wider — a notification and the card it opens
 * describing the same request differently is the failure, and it is the one
 * screen in the product where being exactly right matters most.
 *
 * NO SENTENCE IS WRITTEN HERE. The table's own sentences live in
 * shared/account-copy.ts (V3_COPY) and are BORROWED by id. What this file
 * adds is the row's small furniture — a kind word, a clause, a button label —
 * which the table does not carry and which is not a sentence anybody reads as
 * prose. Those sit in REQUEST_COPY below, the same shape APPROVAL_COPY uses.
 */

// ── the wire (V3-11's contract) ────────────────────────────────────────────

/** One row of GET /v2/me/requests. The fields fill by kind. */
export interface QueueRow {
  id: string
  kind: 'join' | 'reach' | 'seat'
  /** join: the device asking to sign in. reach: the device asking for Wi-Fi. */
  device?: string
  /** seat: the guest's username. */
  account?: string
  /** seat: `@owner/team`. */
  team?: string
  address: string
  at: number
  expiresAt: number
  state: string
  /**
   * reach only: the asking device's PUBLIC key. The Mac seals the pairing URL
   * to it, so the registry relays a credential it cannot read, and the device
   * id the token is minted for is this key's own thumbprint — the token and
   * the seal therefore name the same device by construction.
   */
  askKey?: Record<string, string>
}

/** account:changed, as GET /v2/me/events?since= lists it. */
export interface AccountEvent {
  seq: number
  kind: 'joined' | 'revoked' | 'password-changed' | 'door-moved' | 'not-me' | 'request'
  device?: string
  address?: string
  at: number
}

/** What this Mac DID about a request. The local half of the queue. */
export type AnsweredOutcome = 'joined' | 'allowed' | 'seated' | 'denied'

/**
 * A row that is over, kept on this Mac for seven days.
 *
 * LOCAL BY NECESSITY, not by preference. Every sentence an over-state says is
 * first person — "approved here", "allowed here", "seated by you" — and the
 * registry's queue only lists what is still WAITING. The thing that knows this
 * Mac answered is this Mac.
 */
export interface AnsweredRow {
  id: string
  kind: 'join' | 'reach' | 'seat'
  outcome: AnsweredOutcome
  /** The subject as its sentence names it: a device name, or a username. */
  subject: string
  /** seat only, for the sentence that names the room. */
  team?: string
  at: number
}

/** Rows keep seven days, then move to the Devices tab's history (D11). */
export const KEEP_ANSWERED_MS = 7 * 24 * 60 * 60 * 1000

/**
 * The two digits the asking device shows and this one must type (R3, V3-09).
 * 10–99: no leading zero, so there is one shape to read and one to compare.
 */
export const MATCH_SHAPE = /^[1-9][0-9]$/
export const isMatchComplete = (value: string): boolean => MATCH_SHAPE.test(value.trim())

/**
 * The label the pairing URL is sealed under, and the one the phone opens with.
 * Part of the wire contract rather than an implementation detail: two sides
 * that disagree about it produce a seal that never opens and no way to see why.
 */
export const reachSealInfo = (requestId: string): string => `reach:${requestId}`

// ── the furniture the table does not own ───────────────────────────────────

export const REQUEST_COPY = {
  /** The first clause of each detail line: which kind of asking this is. */
  JOIN_KIND: 'Sign-in',
  REACH_KIND: 'Wi-Fi',
  SEAT_KIND: 'Seat',
  /**
   * The reach row's second clause. It is the fact that makes ALLOW safe to
   * consider: this is not a stranger, it is a device already on the account,
   * asking for something the account alone does not give it.
   */
  ON_ACCOUNT: 'already on the account',
  /** The three over-state clauses. First person: this Mac is the one that acted. */
  OVER_APPROVED: 'approved here',
  OVER_ALLOWED: 'allowed here',
  OVER_SEATED: 'seated by you',
  OVER_DENIED: 'denied here',
  /** The chip at the end of a finished row. */
  CHIP_DONE: 'DONE',
  CHIP_LAN: 'LAN',
  CHIP_SEATED: 'SEATED',
  CHIP_NOT_ME: 'NOT ME',
  /** The buttons, by row kind. */
  APPROVE: 'APPROVE',
  DENY: 'DENY',
  NOT_ME: 'NOT ME',
  ALLOW: 'ALLOW',
  NOT_NOW: 'NOT NOW',
  SEAT_THEM: 'SEAT THEM',
  DECLINE: 'DECLINE',
  /** The tab, and the notification's title. */
  TAB: 'REQUESTS',
  NOTIFY_TITLE: 'Cookrew',
  /**
   * How much rope is left on a wrong number (R3). The count is said because
   * "wrong" with no idea how many tries remain is the sentence people retype
   * into until there are none — and the last one ends the sign-in rather than
   * merely refusing it, which is a different thing to do about it.
   */
  TRIES_LEFT: '{n} tries left.',
  TRIES_ONE: 'One try left.',
  TRIES_NONE: 'That sign-in is over. It can be started again on the other device.',
} as const

/** The lead of a table sentence that carries its explanation in a second one. */
const leadOf = (sentence: string): string => {
  const cut = sentence.indexOf('. ')
  return cut === -1 ? sentence : sentence.slice(0, cut + 1)
}

/**
 * The facts the copy table has no sentence for. They are states of the account
 * rather than moments in a ceremony, so they are stated plainly — and each one
 * still names the thing that changed for the person reading it.
 */
export const ACCOUNT_EVENT_PLAIN = {
  passwordChanged: 'The password changed. Every other device was signed out.',
  anotherDevice: 'another device',
  someDoor: 'A door',
  request: 'Something is waiting in Requests.',
} as const

/**
 * What an account:changed is ANNOUNCED as.
 *
 * Every kind has a sentence, and five of the six borrow one the table already
 * owns — a revoke, a move and a disowned sign-in are moments a person has read
 * about elsewhere in this product, and reading them differently here would be
 * two accounts of the same event. `request` is the exception and is deliberately
 * the vaguest: a row arriving is announced by the ROW (rowNotice), which knows
 * what kind it is, so this sentence is only ever the fallback for an event with
 * no row behind it yet.
 */
export function eventNotice(event: AccountEvent, username: string): string {
  const device = event.device ?? ACCOUNT_EVENT_PLAIN.anotherDevice
  switch (event.kind) {
    case 'joined':
      return accountCopy('d11.join-done', { device, handle: username })
    case 'revoked':
      // The lead only: the whole table sentence is the confirmation a person
      // reads BEFORE revoking, and its second half answers a question nobody
      // is asking once it is done.
      return leadOf(accountCopy('d12.revoke', { device }))
    case 'password-changed':
      return ACCOUNT_EVENT_PLAIN.passwordChanged
    case 'door-moved':
      return accountCopy('d14.moved', { door: event.address ?? ACCOUNT_EVENT_PLAIN.someDoor, device })
    case 'not-me':
      return accountCopy('d11.denied', { handle: username, device })
    case 'request':
      return ACCOUNT_EVENT_PLAIN.request
  }
}

// ── the view model ─────────────────────────────────────────────────────────

export interface RowAction {
  id: 'approve' | 'deny' | 'not-me' | 'allow' | 'not-now' | 'seat-them' | 'decline'
  label: string
  /** primary is the common answer; revoke is the heavy one; ghost is the alarm. */
  tone: 'primary' | 'revoke' | 'ghost'
  /** True when the button cannot fire until the number is filled (join only). */
  needsMatch?: boolean
}

export interface RequestRowView {
  id: string
  kind: 'join' | 'reach' | 'seat'
  /** Two letters for the row's square: MS, iP, JK. */
  initials: string
  lead: string
  detail: string
  /** The number field's label, on the join row and nowhere else. */
  matchLabel: string | null
  actions: readonly RowAction[]
  /** DONE · LAN · SEATED · NOT ME when the row is over; null while it waits. */
  chip: string | null
}

/**
 * Two letters, from the thing the row is about.
 *
 * The initials of two words when there are two ("Mac Studio" → MS), and the
 * first two characters when there is one.
 *
 * A PERSON IS RAISED AND A MACHINE IS NOT, which is why the leading @ is read
 * rather than stripped and forgotten. A username is written lowercase by rule,
 * so "@jkim" is drawn JK the way initials of a name always are; a device wrote
 * its own name and "iPhone" is drawn iP, because IP would read as something
 * else entirely on a screen about networks.
 */
export function rowInitials(subject: string): string {
  const person = subject.trim().startsWith('@')
  const clean = subject.trim().replace(/^@/, '')
  if (clean.length === 0) return '??'
  const words = clean.split(/\s+/).filter((word) => word.length > 0)
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase()
  const two = clean.length === 1 ? clean : clean.slice(0, 2)
  return person ? two.toUpperCase() : two.length === 1 ? two.toUpperCase() : two
}

/** "1 minute ago" — the clause every row ends with. */
const agoClause = (at: number, now: number): string => `${startedAgo(Math.max(0, now - at))} ago`

const detail = (clauses: readonly string[]): string => clauses.filter((c) => c.length > 0).join(' · ')

export interface RowInput {
  username: string
  now: number
}

/**
 * One waiting row, as the card draws it.
 *
 * Every kind's lead comes from the copy table by id; what differs is which
 * facts the row HAS to put in its detail line. The design's mock has a price
 * and a seated count on the seat row and a device kind on the join row; the
 * queue's wire shape carries neither, so those clauses are absent rather than
 * guessed. A row that invents a "$4" nobody sent is worse than one that says
 * less.
 */
export function pendingRowView(row: QueueRow, input: RowInput): RequestRowView {
  const ago = agoClause(row.at, input.now)
  if (row.kind === 'join') {
    const device = row.device ?? ''
    return {
      id: row.id,
      kind: 'join',
      initials: rowInitials(device),
      lead: accountCopy('d11.join-lead', { device, handle: input.username }),
      detail: detail([REQUEST_COPY.JOIN_KIND, row.address, ago]),
      matchLabel: accountCopy('d11.join-row'),
      actions: [
        // APPROVE IS DEAD UNTIL THE NUMBER IS TYPED (R3). The rung exists
        // because a person can be nagged into tapping a button; it is worth
        // nothing if the button can be tapped without reading the other screen.
        { id: 'approve', label: REQUEST_COPY.APPROVE, tone: 'primary', needsMatch: true },
        { id: 'deny', label: REQUEST_COPY.DENY, tone: 'revoke' },
        { id: 'not-me', label: REQUEST_COPY.NOT_ME, tone: 'ghost' },
      ],
      chip: null,
    }
  }
  if (row.kind === 'reach') {
    const device = row.device ?? ''
    return {
      id: row.id,
      kind: 'reach',
      initials: rowInitials(device),
      lead: leadOf(accountCopy('d11.wifi-row', { device })),
      detail: detail([REQUEST_COPY.REACH_KIND, REQUEST_COPY.ON_ACCOUNT, ago]),
      matchLabel: null,
      actions: [
        { id: 'allow', label: REQUEST_COPY.ALLOW, tone: 'primary' },
        { id: 'not-now', label: REQUEST_COPY.NOT_NOW, tone: 'ghost' },
      ],
      chip: null,
    }
  }
  const handle = row.account ?? ''
  return {
    id: row.id,
    kind: 'seat',
    initials: rowInitials(`@${handle}`),
    lead: accountCopy('d11.seat-row', { handle, team: row.team ?? '' }),
    detail: detail([REQUEST_COPY.SEAT_KIND, `@${handle}`, ago]),
    matchLabel: null,
    actions: [
      { id: 'seat-them', label: REQUEST_COPY.SEAT_THEM, tone: 'primary' },
      { id: 'decline', label: REQUEST_COPY.DECLINE, tone: 'revoke' },
    ],
    chip: null,
  }
}

/** One finished row: what it became, said in the first person, with its chip. */
export function answeredRowView(row: AnsweredRow, input: RowInput): RequestRowView {
  const ago = agoClause(row.at, input.now)
  const person = row.outcome === 'seated'
  const base = {
    id: row.id,
    kind: row.kind,
    initials: rowInitials(person ? `@${row.subject}` : row.subject),
    matchLabel: null,
    actions: [],
  }
  if (row.outcome === 'joined') {
    return {
      ...base,
      lead: accountCopy('d11.join-done', { device: row.subject, handle: input.username }),
      detail: detail([REQUEST_COPY.OVER_APPROVED, ago]),
      chip: REQUEST_COPY.CHIP_DONE,
    }
  }
  if (row.outcome === 'allowed') {
    return {
      ...base,
      lead: accountCopy('d11.wifi-done', { device: row.subject }),
      detail: detail([REQUEST_COPY.OVER_ALLOWED, ago]),
      chip: REQUEST_COPY.CHIP_LAN,
    }
  }
  if (row.outcome === 'seated') {
    return {
      ...base,
      lead: accountCopy('d11.seat-done', { handle: row.subject, team: row.team ?? '' }),
      detail: detail([REQUEST_COPY.OVER_SEATED, ago]),
      chip: REQUEST_COPY.CHIP_SEATED,
    }
  }
  return {
    ...base,
    lead: accountCopy('d11.denied', { handle: input.username, device: row.subject }),
    detail: detail([REQUEST_COPY.OVER_DENIED, ago]),
    chip: REQUEST_COPY.CHIP_NOT_ME,
  }
}

/** Answered rows still inside their seven days, newest first. */
export function keptAnswered(rows: readonly AnsweredRow[], now: number): AnsweredRow[] {
  return rows.filter((row) => now - row.at < KEEP_ANSWERED_MS).sort((a, b) => b.at - a.at)
}

/**
 * The whole card: what is waiting, then what is over.
 *
 * WAITING FIRST, ALWAYS. Within each half it is newest first, but a finished
 * row never sorts above a question — the list exists to be answered, and a
 * queue that buried a live request under this morning's receipts would be a
 * queue nobody trusts to have shown them everything.
 */
export function queueView(
  pending: readonly QueueRow[],
  answered: readonly AnsweredRow[],
  input: RowInput,
): RequestRowView[] {
  const waiting = [...pending].sort((a, b) => b.at - a.at).map((row) => pendingRowView(row, input))
  const over = keptAnswered(answered, input.now).map((row) => answeredRowView(row, input))
  return [...waiting, ...over]
}

/**
 * What the avatar's badge shows (D1): every kind, not only sign-ins.
 *
 * Finished rows are NOT counted. A badge is a number of things to do, and one
 * that included this week's receipts would be a number nobody could ever get
 * to zero — which is how a badge stops being read at all.
 */
export const badgeCount = (pending: readonly QueueRow[]): number => pending.length

/** The notification a newly arrived row is announced as. */
export function rowNotice(row: QueueRow, username: string): string {
  const view = pendingRowView(row, { username, now: row.at })
  return view.lead
}

/**
 * A wrong number, said with the registry's own sentence and the count it sent.
 *
 * The sentence comes from the wire rather than from here on purpose: the
 * registry is the thing that knows WHY it refused, and a second wording
 * invented on this side is how the app and the site end up disagreeing about
 * the same refusal in front of the same person.
 */
export function badMatchNote(triesLeft: number, message?: string): string {
  const rope =
    triesLeft <= 0
      ? REQUEST_COPY.TRIES_NONE
      : triesLeft === 1
        ? REQUEST_COPY.TRIES_ONE
        : REQUEST_COPY.TRIES_LEFT.replace('{n}', String(triesLeft))
  return message === undefined || message.length === 0 ? rope : `${message} ${rope}`
}

/** The queue's footer — what each button in it actually does. */
export const queueFooter = (): string => accountCopy('d11.footer')

/** What the card says when there is nothing waiting and nothing recent. */
export const queueEmpty = (): string => accountCopy('d11.empty')
