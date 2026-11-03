import { describe, expect, it } from 'vitest'
import { buildInbox, parseSecretDetails, type InboxNode, type SousStuckRow } from '../src/main/inbox'
import type { BoardRow } from '../src/shared/board'
import type { CookrewEvent } from '../src/main/event-log'
import type { DispatchRecord } from '../src/main/dispatch'

// THE BUILDER against the real shapes (fix round 1, MEDIUM 7, 8, 11): the
// Board's rows, the dispatch registry, and the sealed lane's audit events as
// index.ts writes them — entityId = the asking terminal, details = `<name>` or
// `<name> note:<id>`.

const NOW = Date.parse('2026-10-11T12:00:00Z')
const m = (n: number): number => NOW - n * 60_000

const node = (id: string, kind: InboxNode['kind'] = 'terminal', served = false): InboxNode => ({ id, name: id[0].toUpperCase() + id.slice(1), kind, workspaceId: 'ws', workspaceName: 'Dev', served })
const brow = (terminalId: string, phase: BoardRow['phase'], patch: Partial<BoardRow> = {}): BoardRow => ({
  terminalId,
  agent: { name: terminalId, preset: 'Claude Code', role: null, orch: false },
  workspace: { id: 'ws', name: 'Dev', active: true },
  cwd: '/repo',
  task: { title: 'replace the headings too?', summary: 'summary', turnIndex: 3, startedAt: m(40), endedAt: null },
  phase,
  source: 'live',
  lastActivityAt: m(4),
  turnCount: 3,
  ...patch
})
const secretEvent = (type: 'secret.requested' | 'secret.read', terminalId: string, details: string, at: number): CookrewEvent => ({
  type,
  entityId: terminalId,
  entityName: terminalId,
  workspaceId: 'ws',
  workspaceName: 'Dev',
  actor: 'agent',
  timestamp: at,
  details
})

function build(input: { rows?: BoardRow[]; nodes?: InboxNode[]; connections?: { a: string; b: string }[]; dispatches?: DispatchRecord[]; events?: CookrewEvent[]; sous?: SousStuckRow[] }) {
  return buildInbox({
    rows: () => input.rows ?? [],
    nodes: () => input.nodes ?? [],
    connections: () => input.connections ?? [],
    dispatches: () => input.dispatches ?? [],
    events: (type, since) => (input.events ?? []).filter((e) => e.type === type && e.timestamp >= since),
    sous: () => input.sous ?? [],
    now: () => NOW
  })
}

describe('buildInbox', () => {
  it('a waiting card: since is when it started waiting, and blocked counts only downstream cards idle on it', () => {
    const rows = build({
      rows: [brow('forge', 'waiting'), brow('tinker', 'unread'), brow('magpie', 'done'), brow('atlas', 'waiting')],
      nodes: [node('forge'), node('tinker'), node('magpie'), node('atlas'), node('n1', 'note')],
      // forge → tinker (unread: blocked), forge → magpie (done: not), atlas → forge (upstream: not counted), forge → note (not a terminal)
      connections: [
        { a: 'forge', b: 'tinker' },
        { a: 'forge', b: 'magpie' },
        { a: 'atlas', b: 'forge' },
        { a: 'forge', b: 'n1' }
      ]
    })
    const forge = rows.find((r) => r.nodeId === 'forge')
    expect(forge?.since).toBe(m(4))
    expect(forge?.blockedDownstream).toBe(1)
    expect(forge?.reasons[0]).toBe('asks you — replace the headings too?')
    // atlas has forge downstream, but forge is waiting on a person, not on atlas... it IS idle on it
    expect(rows.find((r) => r.nodeId === 'atlas')?.blockedDownstream).toBe(1)
  })

  it('a secret request is the ASKER’s row, merged with its waiting row, and clicks through to the note the producer named', () => {
    const rows = build({
      rows: [brow('tinker', 'waiting')],
      nodes: [node('tinker'), node('note-7', 'note')],
      events: [secretEvent('secret.requested', 'tinker', 'STRIPE_SECRET_KEY note:note-7', m(1))]
    })
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row.nodeId).toBe('tinker')
    expect(row.nodeKind).toBe('terminal')
    expect(row.kind).toBe('secret')
    expect(row.kinds).toEqual(['secret', 'waiting'])
    expect(row.slot).toBe('STRIPE_SECRET_KEY')
    expect(row.noteId).toBe('note-7')
    expect(row.reasons[0]).toBe('needs STRIPE_SECRET_KEY — seal it')
  })

  it('a request with no note lands on the asker; a later secret.read clears it; a name that was never asked is nothing', () => {
    const asked = build({ nodes: [node('tinker')], events: [secretEvent('secret.requested', 'tinker', 'API_KEY', m(5))] })
    expect(asked).toHaveLength(1)
    expect(asked[0].noteId).toBeUndefined()
    const read = build({
      nodes: [node('tinker')],
      events: [secretEvent('secret.requested', 'tinker', 'API_KEY', m(5)), secretEvent('secret.read', 'tinker', 'API_KEY', m(2))]
    })
    expect(read).toEqual([])
    expect(parseSecretDetails('API_KEY note:n1')).toEqual({ name: 'API_KEY', noteId: 'n1' })
    expect(parseSecretDetails('API_KEY')).toEqual({ name: 'API_KEY', noteId: null })
    expect(parseSecretDetails('')).toBeNull()
  })

  it('a failed delivery is a row with the error; a served card weighs double', () => {
    const record = (agentId: string, state: DispatchRecord['state'], updatedAt: number, error?: string): DispatchRecord =>
      ({ id: `d-${agentId}`, agentId, agentName: agentId, workspaceId: 'ws', state, via: 'herdr', createdAt: updatedAt - 1000, updatedAt, ...(error ? { error } : {}) }) as DispatchRecord
    const rows = build({
      nodes: [node('forge'), node('guest', 'terminal', true)],
      dispatches: [record('forge', 'failed', m(10), 'owner is composing — the input box is theirs'), record('guest', 'interrupted', m(10)), record('forge', 'done', m(1))]
    })
    expect(rows.map((r) => r.nodeId)).toEqual(['guest', 'forge'])
    expect(rows[1].reasons[0]).toBe('delivery failed — owner is composing — the input box is theirs')
    expect(rows[0].served).toBe(true)
  })

  // Observed live after the restarts: 60 of 102 records 'interrupted —
  // observer never materialized' for asks that plainly ran. Until the engine's
  // probation is fixed, a card the Board saw active AFTER the dispatch took it.
  it('a failed or interrupted delivery is NOT a row when the card had any turn activity after the dispatch', () => {
    const record = (agentId: string, state: DispatchRecord['state'], createdAt: number, error?: string): DispatchRecord =>
      ({ id: `d-${agentId}`, agentId, agentName: agentId, workspaceId: 'ws', state, via: 'herdr', createdAt, updatedAt: createdAt + 60_000, ...(error ? { error } : {}) }) as DispatchRecord
    const rows = build({
      rows: [
        // forge: dispatched at -10 min, active at -4 → it ran; no row
        brow('forge', 'done', { lastActivityAt: m(4), task: { title: 'haiku', summary: 'haiku', turnIndex: 4, startedAt: m(9), endedAt: m(4) } }),
        // atlas: dispatched at -10, last active at -20, its turn started before → nothing since; row
        brow('atlas', 'done', { lastActivityAt: m(20), task: { title: 'old', summary: 'old', turnIndex: 2, startedAt: m(30), endedAt: m(20) } }),
        // tinker: lastActivityAt is stale but a turn STARTED after the dispatch; no row
        brow('tinker', 'working', { lastActivityAt: m(12), task: { title: 'new', summary: 'new', turnIndex: 5, startedAt: m(8), endedAt: null } })
      ],
      nodes: [node('forge'), node('atlas'), node('tinker'), node('guest')],
      dispatches: [
        record('forge', 'interrupted', m(10), 'observer never materialized'),
        record('atlas', 'interrupted', m(10), 'observer never materialized'),
        record('tinker', 'failed', m(10)),
        // guest has no Board row at all: nothing says it ran, so it stays
        record('guest', 'interrupted', m(10))
      ]
    })
    expect(rows.map((r) => r.nodeId).sort()).toEqual(['atlas', 'guest'])
  })

  // HP: Sous's own stuck deliveries come from the ledger, carry the proposal
  // text and a RETRY, are dismissable, and hide once the card moved after them.
  it('a sous row: the ledger\'s stuck proposal, RETRY + dismissable, hidden once the card was active after it', () => {
    const rows = build({
      rows: [brow('tinker', 'done', { lastActivityAt: m(2), task: { title: 'ran', summary: 'ran', turnIndex: 4, startedAt: m(3), endedAt: m(2) } })],
      nodes: [node('forge'), node('tinker')],
      sous: [
        { token: 'tok-1', deliveredTo: 'forge', proposalText: 'push the branch\n\nBoundaries: push only after the check passes', outcome: 'interrupted', updatedAt: m(5) },
        { token: 'tok-0', deliveredTo: 'forge', proposalText: 'older', outcome: 'failed', updatedAt: m(50) },
        { token: 'tok-2', deliveredTo: 'tinker', proposalText: 'ran fine', outcome: 'failed', updatedAt: m(10) }
      ]
    })
    expect(rows.map((r) => r.nodeId)).toEqual(['forge'])
    expect(rows[0]).toMatchObject({ kind: 'sous', action: 'retry', dismissable: true, id: 'tok-1', text: 'push the branch\n\nBoundaries: push only after the check passes' })
    expect(rows[0].reasons[0]).toBe("Sous's brief interrupted — retry")
  })
})
