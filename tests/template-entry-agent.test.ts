import { describe, expect, it } from 'vitest'
import { entryAgentOf, type TeamSnapshot } from '../src/main/teams'
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
