// THE INBOX, BUILT (route program R3). Four signals, one ranked list.
//
//   waiting   the Board's phase — a permission prompt, an AskUserQuestion
//   dispatch  a delivery that failed or was interrupted (~/.cookrew/dispatches.jsonl)
//   secret    `secret.requested` in the event log, until `secret.read` answers it (lane sealed)
//   signin    a browser card at a sign-in wall — no signal exists for it yet; the kind
//             stays in the type and the report says so
//
// Pure over its sources, so a test feeds it rows and events and reads the
// list; main wires the sources once (index.ts) and announces changes through
// `createInboxBus`, change-gated on what the rows SAY rather than on the
// clock, because the wait is printed by the box from `since`.

import { EventEmitter } from 'node:events'
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

const IDLE = new Set(['done', 'unread', 'waiting'])

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

  // Cards wired to X that sit idle: the work X is holding up.
  const blockedDownstream = (id: string): number => {
    const neighbours = new Set<string>()
    for (const c of connections) {
      if (c.a === id) neighbours.add(c.b)
      else if (c.b === id) neighbours.add(c.a)
    }
    return [...neighbours].filter((n) => nodes.get(n)?.kind === 'terminal' && IDLE.has(phase.get(n) ?? '')).length
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
      since: row.task.startedAt || row.lastActivityAt,
      blockedDownstream: blockedDownstream(node.id)
    })
  }

  const latestStuck = new Map<string, DispatchRecord>()
  for (const record of sources.dispatches()) {
    if (record.state !== 'failed' && record.state !== 'interrupted') continue
    if (record.updatedAt < now - DISPATCH_WINDOW_MS) continue
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
    // The click lands on the note that carries the slot when the event names
    // one; otherwise on the asking card, whose zoom is where the slot is made.
    const note = slot.noteId ? nodes.get(slot.noteId) : undefined
    const landing = note ?? asker
    items.push({
      kind: 'secret',
      ...base(landing),
      nodeName: asker.name,
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

export interface InboxBus extends EventEmitter {
  /** The rows as of the last build (cheap; the build runs on `touch`). */
  current: () => InboxRow[]
  /** Recompute, and emit `inbox` with the rows when what they say changed. */
  touch: () => InboxRow[]
}

/**
 * The change gate. Sources fire on every store op and every event; the bus
 * rebuilds (cheap: a few hundred rows at most) and tells the window and the
 * phone only when a row appeared, left, or changed its words.
 */
export function createInboxBus(build: () => InboxRow[]): InboxBus {
  const bus = new EventEmitter() as InboxBus
  let rows: InboxRow[] = []
  let stamp = ''
  bus.current = () => rows
  bus.touch = () => {
    rows = build()
    const next = inboxStamp(rows)
    if (next !== stamp) {
      stamp = next
      bus.emit('inbox', rows)
    }
    return rows
  }
  return bus
}
