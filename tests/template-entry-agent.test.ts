import { describe, expect, it } from 'vitest'
import { entryAgentOf, leaderOf, orchAgentOf, withLeader, type TeamSnapshot } from '../src/main/teams'
import type { CanvasNode } from '../src/shared/model'

const term = (name: string, orch = false): CanvasNode =>
  ({ kind: 'terminal', id: `t-${name}`, name, preset: 'Claude Code', command: '', cwd: '/tmp', orch, role: null }) as CanvasNode

const snap = (nodes: CanvasNode[], entryAgent?: string): TeamSnapshot => ({
  name: 'Crew', savedAt: 1, dir: '/tmp', nodes, connections: [], turns: {},
  ...(entryAgent ? { entryAgent } : {})
})

describe('entryAgentOf — a template is a preset with one door', () => {
  it('is the orch-flagged terminal when present', () => {
    expect(entryAgentOf(snap([term('Scout'), term('Conductor', true), term('Editor')]))).toBe('Conductor')
  })
  it('falls back to the first terminal when nothing is flagged (older snapshot)', () => {
    expect(entryAgentOf(snap([term('Scout'), term('Editor')]))).toBe('Scout')
  })
  it('honours an explicit entryAgent that still exists', () => {
    expect(entryAgentOf(snap([term('Scout'), term('Editor')], 'Editor'))).toBe('Editor')
  })
  it('ignores a stale entryAgent naming a node that is gone, and re-derives', () => {
    expect(entryAgentOf(snap([term('Scout', true)], 'Deleted'))).toBe('Scout')
  })
  it('is null for a template with no terminal — one you cannot enter', () => {
    expect(entryAgentOf(snap([]))).toBeNull()
  })
})

/**
 * SERVING's door, which is NOT the import door above. `entryAgentOf` answers
 * "which agent do I enter this template through", and its first-terminal
 * fallback is right for a local import — the owner is opening their own crew.
 * Serving asks a different question with a stranger on the other end, and the
 * owner ruled (2026-08-26) that the answer must be an ORCH or nothing: a team
 * saved without one served fine and "answered" by running the caller's text in
 * zsh. So this one never falls back, and every no-fallback case below is a door
 * that must stay shut rather than open onto the first terminal.
 */
describe('orchAgentOf — a SERVED crew has an orch or it has no door', () => {
  it('is the orch-flagged terminal', () => {
    expect(orchAgentOf(snap([term('Scout'), term('Conductor', true), term('Editor')]))).toBe(
      'Conductor'
    )
  })

  it('is NULL for a crew with terminals but no orch — never the first terminal', () => {
    // The G1 bug in one assertion: entryAgentOf answers 'Scout' here, and that
    // answer is what put a stranger's prompt on a zsh prompt.
    expect(entryAgentOf(snap([term('Scout'), term('Editor')]))).toBe('Scout')
    expect(orchAgentOf(snap([term('Scout'), term('Editor')]))).toBeNull()
  })

  it('is null for a crew with no terminals at all', () => {
    expect(orchAgentOf(snap([]))).toBeNull()
  })

  it('cannot be promoted by entryAgent: naming a non-orch does not make one', () => {
    // entryAgent is a CACHE of the same fallback (TeamStore.save writes
    // orch-else-first into it), so honouring it here would re-open the exact
    // hole by another route — a shell team saves with entryAgent set.
    expect(orchAgentOf(snap([term('Scout'), term('Editor')], 'Editor'))).toBeNull()
  })

  it('lets entryAgent break a tie BETWEEN orchs, which is all it may do', () => {
    const two = snap([term('Ana', true), term('Bo', true)], 'Bo')
    expect(orchAgentOf(two)).toBe('Bo')
  })

  it('ignores an entryAgent naming a node that is gone and still answers an orch', () => {
    expect(orchAgentOf(snap([term('Scout', true)], 'Deleted'))).toBe('Scout')
  })

  it('does not mistake an orch-flagged NON-terminal for a door', () => {
    const browser = { kind: 'browser', id: 'b1', name: 'Docs', orch: true } as unknown as CanvasNode
    expect(orchAgentOf(snap([browser]))).toBeNull()
  })
})

/**
 * THE LEADER (owner ruling, 2026-09-05): the first agent terminal the owner
 * SELECTED leads the exported team — no orch node needed. TeamStore.save
 * stamps the leader as the snapshot's one orch, so orchAgentOf above keeps
 * answering the door without a second field, and every no-orch refusal
 * becomes a no-terminal refusal.
 */
describe('leaderOf / withLeader — the first selected terminal leads', () => {
  const nodes = [term('Scout'), term('Conductor', true), term('Editor')]

  it('is the first terminal in SELECTION order, not canvas order, not the orch', () => {
    expect(leaderOf(nodes, ['t-Editor', 't-Conductor', 't-Scout'])?.name).toBe('Editor')
    expect(leaderOf(nodes, ['t-Scout', 't-Conductor'])?.name).toBe('Scout')
  })

  it('skips selected non-terminals and ids that are not in the team', () => {
    const browser = { kind: 'browser', id: 'b1', name: 'Docs' } as unknown as CanvasNode
    expect(leaderOf([browser, ...nodes], ['b1', 'gone', 't-Editor'])?.name).toBe('Editor')
  })

  it('without a selection order keeps the workspace orch, else the first terminal', () => {
    expect(leaderOf(nodes, [])?.name).toBe('Conductor')
    expect(leaderOf([term('Scout'), term('Editor')], [])?.name).toBe('Scout')
    expect(leaderOf([], ['t-Scout'])).toBeNull()
  })

  it('stamps the leader as the one orch on NEW node objects', () => {
    const stamped = withLeader(nodes, 't-Editor')
    expect(stamped.map((n) => [n.name, (n as { orch?: boolean }).orch])).toEqual([
      ['Scout', false],
      ['Conductor', false],
      ['Editor', true]
    ])
    // The live workspace's own orch is untouched.
    expect((nodes[1] as { orch?: boolean }).orch).toBe(true)
    expect(stamped[1]).not.toBe(nodes[1])
    expect(orchAgentOf(snap(stamped))).toBe('Editor')
  })

  it('with no leader leaves the nodes as they are', () => {
    expect(withLeader(nodes, null).map((n) => (n as { orch?: boolean }).orch)).toEqual([false, true, false])
  })
})
