// THE INBOX, WIRED (route program R3, fix round 1). What the first round did
// inline in index.ts, and did too often: a rebuild on every store op, every
// event-log line and every probe announce, whether or not anyone was looking,
// and feeding itself (a `sous.decide` line rebuilt the list that caused it).
//
// Now: the list is built only while a client HOLDS it (the window's
// subscription, an open /api/events stream), on a trailing 400 ms debounce
// over the signals, never on `sous.*` events, and on demand for a one-shot
// read (the phone's opening frame, the IPC list). Announced only when its
// words change (inboxStamp).

import { EventEmitter } from 'node:events'
import { statSync } from 'node:fs'
import type { InboxRow } from '../shared/inbox-rank'
import { inboxStamp } from './inbox'
import { readDispatchRecords, type DispatchRecord } from './dispatch'

export interface InboxWiringDeps {
  build: () => InboxRow[]
  /** The signals a rebuild may follow. Each returns its unsubscribe. */
  /** Every store op, WITH the op: Sous's own notes are ops too and must not rebuild the list they came from. */
  onStoreOp: (cb: (op: { type: string }) => void) => () => void
  onEvent: (cb: (event: { type: string }) => void) => () => void
  onProbeChange: (cb: () => void) => () => void
  /** The Sous ledger moved (a delivery settled, a row dismissed, a retry). Optional. */
  onLedgerChange?: (cb: () => void) => () => void
  /** Where a changed list goes: the window, the phone streams. */
  announce: (rows: InboxRow[]) => void
  debounceMs?: number
  setTimeout?: typeof globalThis.setTimeout
  clearTimeout?: typeof globalThis.clearTimeout
}

export interface InboxWiring {
  /** `inbox` with the rows, for a stream that forwards announcements. */
  on: (event: 'inbox', cb: (rows: InboxRow[]) => void) => void
  removeListener: (event: 'inbox', cb: (rows: InboxRow[]) => void) => void
  /** A client is looking; the release stops the rebuilds when the last one leaves. */
  hold: () => () => void
  /** Build now, for a one-shot reader; announces if the words changed. */
  read: () => InboxRow[]
  subscribers: () => number
  /** Test seam: how many builds have run. */
  rebuilds: () => number
  stop: () => void
}

export const INBOX_DEBOUNCE_MS = 400

/** Lines the inbox itself causes (Sous's notes land as store ops AND as events), or that cannot change it. */
const IGNORED_EVENT_PREFIXES = ['sous.']
const ignored = (type: string): boolean => IGNORED_EVENT_PREFIXES.some((p) => type.startsWith(p))

export function wireInbox(deps: InboxWiringDeps): InboxWiring {
  const bus = new EventEmitter()
  const set = deps.setTimeout ?? globalThis.setTimeout.bind(globalThis)
  const clear = deps.clearTimeout ?? globalThis.clearTimeout.bind(globalThis)
  const debounceMs = deps.debounceMs ?? INBOX_DEBOUNCE_MS
  let subscribers = 0
  let rebuilds = 0
  let stamp = ''
  let rows: InboxRow[] = []
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null

  const build = (): InboxRow[] => {
    rebuilds += 1
    rows = deps.build()
    const next = inboxStamp(rows)
    if (next !== stamp) {
      stamp = next
      deps.announce(rows)
      bus.emit('inbox', rows)
    }
    return rows
  }
  // Trailing: the LAST signal in a burst decides when, so a storm of probe
  // announces is one build when it ends.
  const schedule = (): void => {
    if (subscribers === 0) return
    if (timer !== null) clear(timer)
    timer = set(() => {
      timer = null
      build()
    }, debounceMs)
  }
  const offs = [
    deps.onStoreOp((op) => {
      if (ignored(op.type)) return
      schedule()
    }),
    deps.onEvent((event) => {
      if (ignored(event.type)) return
      schedule()
    }),
    deps.onProbeChange(schedule),
    ...(deps.onLedgerChange ? [deps.onLedgerChange(schedule)] : [])
  ]
  return {
    on: (event, cb) => void bus.on(event, cb),
    removeListener: (event, cb) => void bus.removeListener(event, cb),
    hold: () => {
      subscribers += 1
      let held = true
      return () => {
        if (!held) return
        held = false
        subscribers -= 1
        if (subscribers === 0 && timer !== null) {
          clear(timer)
          timer = null
        }
      }
    },
    read: build,
    subscribers: () => subscribers,
    rebuilds: () => rebuilds,
    stop: () => {
      for (const off of offs) off()
      if (timer !== null) clear(timer)
      timer = null
    }
  }
}

/**
 * The dispatch registry is a JSONL file that is appended to a few times an
 * hour; the inbox asked for every record on every build. Read it again only
 * when the file's size or mtime moved.
 */
export function cachedDispatchReader(file: string): () => DispatchRecord[] {
  let seen = ''
  let records: DispatchRecord[] = []
  return () => {
    let key = 'missing'
    try {
      const stat = statSync(file)
      key = `${stat.size}:${stat.mtimeMs}`
    } catch {
      key = 'missing'
    }
    if (key !== seen) {
      seen = key
      records = key === 'missing' ? [] : readDispatchRecords(file)
    }
    return records
  }
}
