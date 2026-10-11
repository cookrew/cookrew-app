// THE INBOX, BUILT (route program R3). Four signals, one ranked list.
//
//   waiting   the Board's phase — a permission prompt, an AskUserQuestion
//   dispatch  a delivery that failed or was interrupted (~/.cookrew/dispatches.jsonl) — only while the card has been quiet since
//   secret    `secret.requested` in the event log, until `secret.read` answers it (lane sealed)
//   signin    a browser card at a sign-in wall — no signal exists for it yet; the kind
//             stays in the type and the report says so
//
// Pure over its sources, so a test feeds it rows and events and reads the
// list; inbox-wiring.ts decides WHEN it is built and announces a change,
// gated on what the rows SAY (inboxStamp) rather than on the clock, because
// the wait is printed by the box from `since`.

import type { BoardRow } from '../shared/board'
import { rankInbox, type InboxItem, type InboxRow } from '../shared/inbox-rank'
import type { CookrewEvent } from './event-log'
import type { DispatchRecord } from './dispatch'

export interface InboxNode {
  id: string
  name: string
  kind: 'terminal' | 'browser' | 'note'
  workspaceId: string
  workspaceName: string
  /** A card that is somebody else's seat at this machine. */
  served: boolean
}

export interface InboxSources {
  rows: () => readonly BoardRow[]
  nodes: () => readonly InboxNode[]
  connections: () => readonly { a: string; b: string }[]
  dispatches: () => readonly DispatchRecord[]
  /** Events of the given type prefix, newest last. */
  events: (type: string, since: number) => readonly CookrewEvent[]
  now?: () => number
}

/** How far back a stuck delivery or an unanswered secret still counts. */
export const DISPATCH_WINDOW_MS = 24 * 60 * 60 * 1000
export const SECRET_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** Did this card show any turn activity after `at`? Unknown (no row) = no. */
export function activeSince(row: BoardRow | undefined, at: number): boolean {
  if (!row) return false
  return row.lastActivityAt > at || row.task.startedAt > at || (row.task.endedAt ?? 0) > at
}

/** `secret.requested` details: "<name>" or "<name> note:<noteId>". */
export function parseSecretDetails(details: string | undefined): { name: string; noteId: string | null } | null {
  const text = (details ?? '').trim()
  if (!text) return null
  const match = /^(\S+)(?:\s+note:(\S+))?/.exec(text)
  if (!match) return null
  return { name: match[1], noteId: match[2] ?? null }
}

export function buildInbox(sources: InboxSources): InboxRow[] {
  const now = sources.now?.() ?? Date.now()
  const rows = sources.rows()
  const nodes = new Map(sources.nodes().map((n) => [n.id, n]))
  const phase = new Map(rows.map((r) => [r.terminalId, r.phase]))
  const connections = sources.connections()

  // The work X is holding up: cards DOWNSTREAM of it (edges from X) that sit
  // idle waiting on it — `unread` or `waiting`, never `done`, which is a card
  // that finished and owes nobody anything.
  const WAITING_ON = new Set(['unread', 'waiting'])
  const blockedDownstream = (id: string): number => {
    const downstream = new Set<string>()
    for (const c of connections) if (c.a === id) downstream.add(c.b)
    return [...downstream].filter((n) => nodes.get(n)?.kind === 'terminal' && WAITING_ON.has(phase.get(n) ?? '')).length
  }

  const items: InboxItem[] = []
  const base = (node: InboxNode): Pick<InboxItem, 'nodeId' | 'nodeName' | 'nodeKind' | 'workspaceId' | 'workspaceName' | 'served'> => ({
    nodeId: node.id,
    nodeName: node.name,
    nodeKind: node.kind,
    workspaceId: node.workspaceId,
    workspaceName: node.workspaceName,
    served: node.served
  })

  for (const row of rows) {
    if (row.phase !== 'waiting') continue
    const node = nodes.get(row.terminalId)
    if (!node) continue
    const asked = row.task.title ?? row.task.summary
    items.push({
      kind: 'waiting',
      ...base(node),
      reason: asked ? `asks you — ${asked}` : 'asks you',
      // When the card started WAITING — the phase changed on its last
      // activity — not when its turn began.
      since: row.lastActivityAt,
      blockedDownstream: blockedDownstream(node.id)
    })
  }

  // A delivery the ledger calls failed or interrupted, for a card that has
  // shown NO turn activity since the dispatch — one the Board saw active
  // afterwards took the brief whatever the ledger says (observed live: 60 of
  // 102 records 'interrupted — observer never materialized' after restarts,
  // for asks that plainly ran). The engine's probation is the engine's fix;
  // the inbox must not float those.
  const rowOf = new Map(rows.map((row) => [row.terminalId, row] as const))
  const latestStuck = new Map<string, DispatchRecord>()
  for (const record of sources.dispatches()) {
    if (record.state !== 'failed' && record.state !== 'interrupted') continue
    if (record.updatedAt < now - DISPATCH_WINDOW_MS) continue
    if (activeSince(rowOf.get(record.agentId), record.createdAt)) continue
    const seen = latestStuck.get(record.agentId)
    if (!seen || seen.updatedAt < record.updatedAt) latestStuck.set(record.agentId, record)
  }
  for (const [agentId, record] of latestStuck) {
    const node = nodes.get(agentId)
    if (!node) continue
    const why = record.error ? ` — ${record.error.slice(0, 80)}` : ''
    items.push({
      kind: 'dispatch',
      ...base(node),
      reason: `delivery ${record.state}${why}`,
      since: record.updatedAt,
      blockedDownstream: blockedDownstream(node.id)
    })
  }

  const asked = sources.events('secret.requested', now - SECRET_WINDOW_MS)
  const read = sources.events('secret.read', now - SECRET_WINDOW_MS)
  const answered = new Set(read.map((e) => `${e.entityId}:${parseSecretDetails(e.details)?.name ?? ''}`))
  const open = new Map<string, CookrewEvent>()
  for (const event of asked) {
    const slot = parseSecretDetails(event.details)
    if (!slot) continue
    const key = `${event.entityId}:${slot.name}`
    if (answered.has(key)) continue
    const seen = open.get(key)
    if (!seen || seen.timestamp < event.timestamp) open.set(key, event)
  }
  for (const event of open.values()) {
    const slot = parseSecretDetails(event.details)
    if (!slot) continue
    const asker = nodes.get(event.entityId)
    if (!asker) continue
    // The ROW is the asker's — one row per problem, merged with a `waiting`
    // signal about the same card. The click lands on the note the producer
    // named (`note:<id>`) when it exists, else on the asker, whose zoom is
    // where the slot is made.
    const note = slot.noteId ? nodes.get(slot.noteId) : undefined
    items.push({
      kind: 'secret',
      ...base(asker),
      reason: `needs ${slot.name} — seal it`,
      since: event.timestamp,
      blockedDownstream: blockedDownstream(asker.id),
      slot: slot.name,
      ...(note ? { noteId: note.id } : {})
    })
  }

  return rankInbox(items, now)
}

/** What a list says, without the clock: the stamp a change is gated on. */
export function inboxStamp(rows: readonly InboxRow[]): string {
  return rows.map((r) => `${r.nodeId}|${r.kinds.join(',')}|${r.reasons.join(';')}|${r.blockedDownstream}|${r.served ? 1 : 0}`).join('\n')
}
