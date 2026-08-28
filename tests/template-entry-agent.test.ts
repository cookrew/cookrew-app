import { describe, expect, it } from 'vitest'
import { entryAgentOf, orchAgentOf, type TeamSnapshot } from '../src/main/teams'
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
