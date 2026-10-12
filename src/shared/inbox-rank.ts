// THE HITL INBOX, RANKED (route program R3, design section 5).
//
// Four signals say "only a person can move this card": the Board's `waiting`
// phase (a permission prompt, an AskUserQuestion), a dispatch that was refused,
// failed or timed out, an agent asking for a secret, and a browser card at a
// sign-in wall. They arrive from four places; this module turns them into ONE
// list, one row per card, ordered by how much is stuck behind each.
//
// Pure. Main feeds it (src/main/inbox.ts) and the box draws it; the tests own
// the clock.

export type InboxKind = 'waiting' | 'dispatch' | 'secret' | 'signin' | 'sous'

/** HP contract: a `sous` row is Sous's own — a proposal that failed (RETRY), a card to look at (OPEN), or an answer to read (DISMISS). */
export interface SousRowFacts {
  /** The row's id for `POST /api/inbox/:id/act|dismiss`; absent on an older main (the box falls back to nodeId). */
  id?: string
  action?: 'retry' | 'open' | null
  dismissable?: boolean
  /** The proposal or the answer, one line, scrubbed in main. */
  text?: string
}

/** One signal about one card, before merging. */
export interface InboxItem extends SousRowFacts {
  kind: InboxKind
  /** The card the person has to go to. */
  nodeId: string
  nodeName: string
  nodeKind: 'terminal' | 'browser' | 'note'
  workspaceId: string
  workspaceName: string
  /** One short clause: what it is waiting for. */
  reason: string
  /** Epoch ms when the wait began. */
  since: number
  /** A seat somebody paid for — their wait costs money. */
  served: boolean
  /** Cards wired downstream of this one that are idle, waiting on it. */
  blockedDownstream: number
  /** `secret` rows: the slot's name, so a click lands on `[data-secret-slot=name]`. */
  slot?: string
  /** `secret` rows: the note that carries the slot, when it is known. */
  noteId?: string
}

/** One row of the inbox: the card, merged over every signal about it. */
export interface InboxRow extends SousRowFacts {
  nodeId: string
  nodeName: string
  nodeKind: InboxItem['nodeKind']
  workspaceId: string
  workspaceName: string
  /** The kind that wins the row — the one the click acts on. */
  kind: InboxKind
  kinds: InboxKind[]
  /** The reasons, strongest first, deduplicated. */
  reasons: string[]
  since: number
  waitMinutes: number
  served: boolean
  blockedDownstream: number
  score: number
  slot?: string
  noteId?: string
}

/** A secret beats a question beats a stuck delivery beats a sign-in wall:
 *  the order the box resolves a merged row's click in. */
const KIND_RANK: Record<InboxKind, number> = { secret: 0, waiting: 1, dispatch: 2, signin: 3, sous: 4 }

/** (1 + blocked) × log1p(minutes) × (served ? 2 : 1) — design section 5. */
export function inboxScore(input: { blockedDownstream: number; waitMinutes: number; served: boolean }): number {
  const blocked = Math.max(0, input.blockedDownstream)
  const minutes = Math.max(0, input.waitMinutes)
  return (1 + blocked) * Math.log1p(minutes) * (input.served ? 2 : 1)
}

export function rankInbox(items: readonly InboxItem[], now: number): InboxRow[] {
  const byNode = new Map<string, InboxItem[]>()
  for (const item of items) {
    const list = byNode.get(item.nodeId) ?? []
    byNode.set(item.nodeId, [...list, item])
  }
  const rows = [...byNode.values()].map((group) => {
    const sorted = [...group].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.since - b.since)
    const head = sorted[0]
    const since = Math.min(...sorted.map((i) => i.since))
    const waitMinutes = Math.max(0, (now - since) / 60_000)
    const blockedDownstream = Math.max(...sorted.map((i) => i.blockedDownstream))
    const served = sorted.some((i) => i.served)
    const slotted = sorted.find((i) => i.kind === 'secret' && i.slot)
    return {
      nodeId: head.nodeId,
      nodeName: head.nodeName,
      nodeKind: head.nodeKind,
      workspaceId: head.workspaceId,
      workspaceName: head.workspaceName,
      kind: head.kind,
      kinds: [...new Set(sorted.map((i) => i.kind))],
      reasons: [...new Set(sorted.map((i) => i.reason))],
      since,
      waitMinutes,
      served,
      blockedDownstream,
      score: inboxScore({ blockedDownstream, waitMinutes, served }),
      ...(slotted?.slot ? { slot: slotted.slot } : {}),
      ...(slotted?.noteId ? { noteId: slotted.noteId } : {}),
      ...(head.id !== undefined ? { id: head.id } : {}),
      ...(head.action !== undefined ? { action: head.action } : {}),
      ...(head.dismissable !== undefined ? { dismissable: head.dismissable } : {}),
      ...(head.text !== undefined ? { text: head.text } : {})
    }
  })
  // Highest score first; a tie goes to the longer wait, then to the name, so
  // two reads a second apart draw the same list.
  return rows.sort((a, b) => b.score - a.score || a.since - b.since || a.nodeName.localeCompare(b.nodeName))
}

/** "4 m", "2 h", "3 d" — the wait as the box prints it. */
export function waitedFor(waitMinutes: number): string {
  if (waitMinutes < 1) return 'now'
  if (waitMinutes < 60) return `${Math.floor(waitMinutes)} m`
  if (waitMinutes < 60 * 24) return `${Math.floor(waitMinutes / 60)} h`
  return `${Math.floor(waitMinutes / (60 * 24))} d`
}
