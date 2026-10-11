import { describe, expect, it } from 'vitest'
import { buildInbox, parseSecretDetails, type InboxNode } from '../src/main/inbox'
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

function build(input: { rows?: BoardRow[]; nodes?: InboxNode[]; connections?: { a: string; b: string }[]; dispatches?: DispatchRecord[]; events?: CookrewEvent[] }) {
  return buildInbox({
    rows: () => input.rows ?? [],
    nodes: () => input.nodes ?? [],
    connections: () => input.connections ?? [],
    dispatches: () => input.dispatches ?? [],
    events: (type, since) => (input.events ?? []).filter((e) => e.type === type && e.timestamp >= since),
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
})
