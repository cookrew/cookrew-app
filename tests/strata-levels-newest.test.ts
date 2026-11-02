// EACH WORKSPACE'S NEWEST BROWSER, ON THE LEVELS FEED (owner 2026-11-02: the
// zoom like group-motion-pivot.html). The draft's device stop draws a
// workspace's newest browser beside its agents: the way in by its browsers.
// The other workspaces reach the zoom only through this feed, and only the
// desktop knows creation order, so the desktop names it.

import { describe, expect, it } from 'vitest'
import { buildLevels, type LevelsInput } from '../src/main/levels/build'
import type { WorkspaceState } from '../src/shared/model'
import { browser, note, terminal } from './strata-levels-fixture'

const input = (state: WorkspaceState): LevelsInput => ({
  workspaces: [{ meta: { id: 'w1', name: 'One', dir: '/work/x', dirs: ['/work/x'], icon: '' }, state }],
  focusedWorkspaceId: 'w1',
  live: new Map(),
  probe: new Map(),
  ledger: new Map(),
  tuning: () => null,
  harnessOf: () => 'shell',
  memory: new Map(),
  now: 0
})
const state = (nodes: WorkspaceState['nodes']): WorkspaceState => ({ name: 'One', dir: '/work/x', dirs: ['/work/x'], nodes, connections: [] })

describe('the newest browser of a workspace', () => {
  it('is its last browser by creation, notes left out, its address without query or fragment', () => {
    const row = buildLevels(
      input(state([terminal('a1', 'Ada', ''), browser('b1', 'Old', ['https://old.dev/']), browser('b2', 'PR', ['https://github.com/acme/app/pull/1?secret=1#frag']), note('n1', 'later note')]))
    ).workspaces[0]
    expect(row.newest).toMatchObject({ id: 'b2', kind: 'browser', title: 'PR' })
    expect(row.newest?.host).not.toContain('secret')
  })

  it('is absent where there is no browser, so a desktop without one sends what it always did', () => {
    const row = buildLevels(input(state([terminal('a1', 'Ada', ''), note('n1', 'a note')]))).workspaces[0]
    expect('newest' in row).toBe(false)
  })
})
