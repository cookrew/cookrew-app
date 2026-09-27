import { describe, expect, it } from 'vitest'
import type { TeamMeta, WorkspaceList } from '../src/shared/model'
import { nameAfterTemplate, planRemove, templateLabel } from '../src/renderer/src/workspace-wall-actions'

/**
 * WHAT THE WALL CAN DO TO A WORKSPACE, as decisions with no DOM.
 *
 * The header dropdown used to hold these — remove, and create from a saved
 * team — and the rules it enforced (never the last one; leave before you
 * remove the one you are in) move here so the wall enforces the same ones.
 */

const ws = (id: string) => ({ id, name: id, icon: '📁', dir: `/w/${id}`, dirs: [`/w/${id}`] })
const list = (ids: string[], activeId = ids[0]): WorkspaceList => ({
  workspaces: ids.map(ws) as WorkspaceList['workspaces'],
  activeId,
})

describe('removing a workspace', () => {
  it('refuses the last one — there must always be somewhere to stand', () => {
    expect(planRemove(list(['w1']), 'w1')).toEqual({ ok: false, reason: 'last' })
  })

  it('refuses an id the list does not have', () => {
    expect(planRemove(list(['w1', 'w2']), 'gone')).toEqual({ ok: false, reason: 'unknown' })
  })

  it('switches away first when removing the one you are in', () => {
    // The backend also guards this; the wall does it so the user never sees
    // the canvas they are on vanish from under them.
    expect(planRemove(list(['w1', 'w2', 'w3'], 'w1'), 'w1')).toEqual({ ok: true, switchTo: 'w2' })
  })

  it('needs no switch when removing another one', () => {
    expect(planRemove(list(['w1', 'w2'], 'w1'), 'w2')).toEqual({ ok: true, switchTo: null })
  })
})

describe('creating from a saved team', () => {
  const team: TeamMeta = { name: 'goat team', savedAt: Date.UTC(2026, 8, 20), nodeCount: 5, terminalCount: 3 }

  it('labels a template by its size and date', () => {
    expect(templateLabel(team)).toMatch(/^3 agents · /)
    expect(templateLabel({ ...team, terminalCount: 1 })).toMatch(/^1 agent · /)
  })

  it('pre-fills an empty name from the team, and leaves a typed one alone', () => {
    expect(nameAfterTemplate('', 'goat team')).toBe('goat team')
    expect(nameAfterTemplate('   ', 'goat team')).toBe('goat team')
    expect(nameAfterTemplate('mine', 'goat team')).toBe('mine')
    expect(nameAfterTemplate('', null)).toBe('')
  })
})
