import { randomUUID } from 'node:crypto'

/**
 * IDENTITY v3 — account:changed, THE ROSTER'S OWN FEED.
 *
 * The account carries a requests[] list and a stream of things that happened
 * to it: a device joined, one was revoked, the password changed, a door moved,
 * "not me" was pressed, a request arrived. Every device is entitled to know,
 * so the model's word for it is one payload — {kind, device, at, address} —
 * fanned out two ways: pushed down a desktop's canvas link when it holds one
 * (V3-13/14 wire that), and readable by a poll for the web and a phone that
 * does not.
 *
 * THE POLL IS THE TRUTH; THE PUSH IS A SHORTCUT. A device that missed a push
 * (asleep, offline, between links) still learns on its next `since` — so the
 * log is what a client reconciles against, and the push only saves it the
 * wait. Kept in memory and bounded: an event is a fact about a conversation
 * between devices, not a record the account is defined by, and a restart that
 * drops the tail costs a client one catch-up poll of /v2/me — the same thing
 * it does on first load.
 *
 * A CURSOR, NOT A CLOCK. Clients poll `since=<cursor>` and get what is new
 * plus the next cursor. Two events in the same millisecond are still ordered,
 * and a client never re-reads one because the seq is monotonic per account and
 * never derived from `at`.
 */

/** The kinds the model lists. `request` covers a new join/seat/reach arriving. */
export type EventKind =
  | 'joined'
  | 'revoked'
  | 'password-changed'
  | 'door-moved'
  | 'not-me'
  | 'request'

/** account:changed, as every surface reads it. `seq` is the poll cursor. */
export interface AccountEvent {
  seq: number
  kind: EventKind
  /** The device this is about — its name, so a sentence can quote it. Optional. */
  device?: string
  /** Where it happened or came from. Never a city; the registry does no geo. */
  address?: string
  at: number
}

/** What a caller appends. `at` and `seq` are the store's to assign. */
export interface EventInput {
  kind: EventKind
  device?: string
  address?: string
}

/** A listener for the live push — the canvas relay attaches one per process. */
export type EventListener = (username: string, event: AccountEvent) => void

/** More than a device catches up on in one poll; older ones fall off the tail. */
const PER_ACCOUNT = 100

export class V2Events {
  private readonly now: () => number
  private seq = 0
  private readonly log = new Map<string, AccountEvent[]>()
  private readonly listeners = new Set<EventListener>()

  constructor(now: () => number = Date.now) {
    this.now = now
  }

  /**
   * Record what happened, and tell anyone listening live. The seq is global
   * and monotonic so a device that holds sessions on two accounts still never
   * sees a cursor go backwards.
   */
  append(username: string, input: EventInput): AccountEvent {
    const event: AccountEvent = {
      seq: (this.seq += 1),
      kind: input.kind,
      ...(input.device === undefined ? {} : { device: input.device }),
      ...(input.address === undefined ? {} : { address: input.address }),
      at: this.now()
    }
    const held = this.log.get(username) ?? []
    held.push(event)
    // The tail is what a client can still catch up on; the head is history it
    // learned long ago or will re-derive from /v2/me on its next full load.
    this.log.set(username, held.slice(-PER_ACCOUNT))
    for (const listener of this.listeners) listener(username, event)
    return event
  }

  /**
   * What this account has seen since a cursor, and the cursor to poll with
   * next. A cursor from the future (a restart reset the seq) reads as "catch
   * up from the start of what I still hold", which is the safe direction: a
   * client re-reads a few rather than missing any.
   */
  since(username: string, cursor: number): { events: AccountEvent[]; cursor: number } {
    const held = this.log.get(username) ?? []
    const from = Number.isFinite(cursor) ? cursor : 0
    const events = from <= 0 ? [...held] : held.filter((e) => e.seq > from)
    return { events, cursor: events.length > 0 ? events[events.length - 1].seq : Math.min(from, this.seq) }
  }

  /** The canvas relay subscribes once; the returned function detaches it. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/** A fresh id, for a request the queue hands back. Here so both stores share it. */
export const newRequestId = (): string => randomUUID()
