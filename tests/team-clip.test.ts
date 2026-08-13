import { describe, expect, it } from 'vitest'
import type { CanvasNode, TeamCopyResult, WorkspaceMeta, WorkspaceState } from '../src/shared/model'
import { TeamClipboard, type TeamClipDeps } from '../src/main/team-clip'

function terminal(id: string, name = `Agent ${id}`, cwd = '/work/repo'): CanvasNode {
  return { kind: 'terminal', id, name, cwd } as unknown as CanvasNode
}
function note(id: string): CanvasNode {
  return { kind: 'note', id, name: id } as unknown as CanvasNode
}

interface Fake {
  clip: TeamClipboard
  world: {
    activeId: string
    workspaces: { meta: WorkspaceMeta; state: WorkspaceState }[]
    working: Set<string>
    pastes: {
      nodeIds: string[]
      intoWorkspaceId: string
      fromWorkspaceId?: string
      preserveIdentity?: string[]
    }[]
    removed: { nodeIds: string[]; fromWorkspaceId: string }[]
    failPaste: boolean
    resolvePaste: (() => void) | null
  }
}

function fake(): Fake {
  const wsState = (id: string, name: string, nodes: CanvasNode[]): Fake['world']['workspaces'][0] => ({
    meta: { id, name, dir: '/w', icon: '🗂' } as WorkspaceMeta,
    state: { name, dir: '/w', dirs: ['/w'], nodes, connections: [] }
  })
  const world: Fake['world'] = {
    activeId: 'A',
    workspaces: [
      wsState('A', 'Alpha', [terminal('t1'), terminal('t2', 'Sous'), note('n1')]),
      wsState('B', 'Beta', [])
    ],
    working: new Set(),
    pastes: [],
    removed: [],
    failPaste: false,
    resolvePaste: null
  }
  const deps: TeamClipDeps = {
    activeId: () => world.activeId,
    workspaces: () => world.workspaces.map((w) => w.meta),
    workspaceState: (id) => {
      const hit = world.workspaces.find((w) => w.meta.id === id)
      if (!hit) throw new Error('no ws')
      return hit.state
    },
    activeNodes: () => deps.workspaceState(world.activeId).nodes,
    isWorking: (id) => world.working.has(id),
    paste: (spec) => {
      world.pastes.push(spec)
      if (world.failPaste) return Promise.reject(new Error('paste exploded'))
      const result: TeamCopyResult = {
        workspaceId: spec.intoWorkspaceId,
        workspaceName: 'target',
        copiedNodes: spec.nodeIds.length,
        copiedCables: 0
      }
      if (world.resolvePaste === null) return Promise.resolve(result)
      // Hangable paste for the re-entrancy test.
      return new Promise((resolve) => {
        world.resolvePaste = () => resolve(result)
      })
    },
    removeCut: (nodeIds, fromWorkspaceId) => {
      world.removed.push({ nodeIds, fromWorkspaceId })
      return Promise.resolve()
    }
  }
  return { clip: new TeamClipboard(deps), world }
}

describe('TeamClipboard lifecycle', () => {
  it('stages a copy and reports it; unknown ids are dropped at set time', () => {
    const { clip } = fake()
    const status = clip.set(['t1', 'ghost'], false)
    expect(status).toMatchObject({
      count: 1,
      fromWorkspaceName: 'Alpha',
      fromWorkspaceId: 'A',
      cut: false
    })
    // Items carry enough to preview + ghost the landing spot; a copied
    // terminal never identity-moves.
    expect(status.items).toHaveLength(1)
    expect(status.items[0]).toMatchObject({ id: 't1', kind: 'terminal', moves: false })
  })

  it('cut marks session-less items as identity MOVES (stateful transfer)', () => {
    const { clip } = fake()
    const status = clip.set(['t1', 'n1'], true)
    const byId = Object.fromEntries(status.items.map((i) => [i.id, i.moves]))
    // A cut browser/note moves whole (a browser keeps cookies/session — the
    // profile is keyed by node id); the terminal re-ids via session restore.
    expect(byId).toEqual({ t1: false, n1: true })
  })

  it('status carries ONLY the cables with both ends staged — the thumbnail', () => {
    const { clip, world } = fake()
    world.workspaces[0].state = {
      ...world.workspaces[0].state,
      connections: [
        { id: 'c12', a: 't1', b: 't2' },
        { id: 'c1n', a: 't1', b: 'n1' }
      ]
    }
    const status = clip.set(['t1', 't2'], false)
    expect(status.cables).toEqual([{ a: 't1', b: 't2' }])
  })

  it('refuses an empty selection and non-string ids', () => {
    const { clip } = fake()
    expect(() => clip.set([], false)).toThrow(/Nothing selected/)
    expect(() => clip.set('evil' as unknown as string[], true)).toThrow(/string\[\]/)
  })

  it('refuses working agents, by name, at the gesture', () => {
    const { clip, world } = fake()
    world.working.add('t2')
    expect(() => clip.set(['t1', 't2'], true)).toThrow(/wait for “Sous” to finish/)
  })

  it('status prunes when the source workspace vanishes', () => {
    const { clip, world } = fake()
    clip.set(['t1'], false)
    world.workspaces = world.workspaces.filter((w) => w.meta.id !== 'A')
    world.activeId = 'B'
    expect(clip.status()).toBeNull()
    // And a paste against the vanished source refuses cleanly.
    return expect(clip.paste()).rejects.toThrow(/Nothing to paste/)
  })

  it('status prunes when every staged node was removed', () => {
    const { clip, world } = fake()
    clip.set(['t1'], false)
    world.workspaces[0].state = { ...world.workspaces[0].state, nodes: [note('n1')] }
    expect(clip.status()).toBeNull()
  })

  it('copy-paste keeps the clipboard for repeat pastes; no removal', async () => {
    const { clip, world } = fake()
    clip.set(['t1', 'n1'], false)
    world.activeId = 'B'
    await clip.paste()
    await clip.paste()
    expect(world.pastes).toHaveLength(2)
    expect(world.pastes[0]).toEqual({
      nodeIds: ['t1', 'n1'],
      intoWorkspaceId: 'B',
      fromWorkspaceId: 'A'
    })
    expect(world.removed).toHaveLength(0)
    expect(clip.status()?.count).toBe(2)
  })

  it('cut-paste removes sources AFTER the copy and clears the clipboard', async () => {
    const { clip, world } = fake()
    clip.set(['t1'], true)
    world.activeId = 'B'
    await clip.paste()
    expect(world.pastes).toHaveLength(1)
    expect(world.removed).toEqual([{ nodeIds: ['t1'], fromWorkspaceId: 'A' }])
    expect(clip.status()).toBeNull()
    await expect(clip.paste()).rejects.toThrow(/Nothing to paste/)
  })

  it('cut moves notes/browsers by IDENTITY; copy never does', async () => {
    const { clip, world } = fake()
    clip.set(['t1', 'n1'], true)
    world.activeId = 'B'
    await clip.paste()
    // The session-less note transfers ownership; the terminal re-ids.
    expect(world.pastes[0]).toMatchObject({ preserveIdentity: ['n1'] })

    world.activeId = 'A'
    clip.set(['t2', 'n1'], false)
    world.activeId = 'B'
    await clip.paste()
    expect(world.pastes[1].preserveIdentity).toBeUndefined()
  })

  it('a FAILED cut-paste leaves the originals and the clipboard standing', async () => {
    const { clip, world } = fake()
    clip.set(['t1'], true)
    world.activeId = 'B'
    world.failPaste = true
    await expect(clip.paste()).rejects.toThrow(/paste exploded/)
    expect(world.removed).toHaveLength(0)
    expect(clip.status()?.cut).toBe(true)
  })

  it('refuses cut-paste into the SAME workspace it was cut from', async () => {
    const { clip } = fake()
    clip.set(['t1'], true)
    await expect(clip.paste()).rejects.toThrow(/use COPY, or paste in another workspace/)
  })

  it('stages a worktree name and threads it into the paste spec', async () => {
    const { clip, world } = fake()
    const status = clip.set(['t1', 't2'], false, { name: ' fix attempt ' })
    expect(status.worktreeName).toBe('fix attempt')
    world.activeId = 'B'
    await clip.paste()
    expect(world.pastes[0]).toMatchObject({ worktree: { name: 'fix attempt' } })
  })

  it('worktree staging validates at the gesture: name and one shared workdir', () => {
    const { clip, world } = fake()
    expect(() => clip.set(['t1'], false, { name: '  ' })).toThrow(/Name the worktree/)
    world.workspaces[0].state = {
      ...world.workspaces[0].state,
      nodes: [terminal('t1'), terminal('t3', 'Elsewhere', '/other'), note('n1')]
    }
    expect(() => clip.set(['t1', 't3'], false, { name: 'x' })).toThrow(/ONE workdir/)
    expect(() => clip.set(['n1'], false, { name: 'x' })).toThrow(/at least one agent/)
  })

  it('one paste at a time — concurrent second caller is refused', async () => {
    const { clip, world } = fake()
    clip.set(['t1'], true)
    world.activeId = 'B'
    world.resolvePaste = () => undefined // arm the hangable paste
    const first = clip.paste()
    await Promise.resolve() // let pasteInner reach the hanging engine call
    await expect(clip.paste()).rejects.toThrow(/already in progress/)
    world.resolvePaste?.()
    await first
    // The latch releases: with the cut consumed, the next paste says empty.
    await expect(clip.paste()).rejects.toThrow(/Nothing to paste/)
  })
})
