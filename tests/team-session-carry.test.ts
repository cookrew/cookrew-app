import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  CanvasNode,
  TeamCopyResult,
  TerminalNodeData,
  WorkspaceMeta,
  WorkspaceState
} from '../src/shared/model'
import { WorkspaceStore } from '../src/main/store'
import { TeamStore, copyTeam, planTeamFork, type TeamForkSource } from '../src/main/teams'
import { TeamClipboard, type TeamClipDeps } from '../src/main/team-clip'

// CUT-and-paste is a MOVE, not a fork.
//
// The fork engine nulls every session binding on purpose: a COPY diverges
// from an origin that keeps running, and an inherited ref would have two
// processes appending to one rollout. A CUT leaves no origin behind — the
// source card is removed — so the same nulling silently strands the
// conversation: the pasted agent boots empty, and because the turn ledger is
// keyed by TERMINAL ID, the new id has no ledger and the transcript opens
// blank. Measured on “Homelab Codex” pasted into “Baymax Home”: ledger 1
// record, codexSessionRef null, the real conversation left behind.
//
// Same rule the workdir move already follows (session-move.ts): same ref, no
// lineage transition, checkpoint ordinals identical either side of the move.

const CODEX_REF = '/Users/u/.codex/sessions/2026/08/rollout-2026-08-13T10-00-00-019f.jsonl'

function terminal(id: string, patch: Partial<TerminalNodeData> = {}): TerminalNodeData {
  return {
    kind: 'terminal',
    id,
    name: `Agent ${id}`,
    preset: 'Claude Code',
    command: 'claude --permission-mode bypassPermissions',
    cwd: '/work/repo',
    orch: false,
    role: null,
    position: { x: 10, y: 20 },
    size: { width: 400, height: 300 },
    ...patch
  }
}

const codexNode = (id: string): TerminalNodeData =>
  terminal(id, {
    name: 'Homelab Codex',
    preset: 'Codex',
    command: 'codex --dangerously-bypass-approvals-and-sandbox',
    codexSessionRef: CODEX_REF,
    claudeSessionId: null
  })

function source(nodes: CanvasNode[]): TeamForkSource {
  return {
    name: 'Home',
    dir: '/work/repo',
    dirs: ['/work/repo'],
    nodes,
    connections: [],
    turnsOf: () => [],
    fromSnapshot: false
  }
}

const plannedTerminal = (plan: ReturnType<typeof planTeamFork>): TerminalNodeData =>
  plan.nodes.find((n) => n.kind === 'terminal') as TerminalNodeData

// ---------------------------------------------------------------------------
// The planner: what a carried card keeps, and what a forked one still drops.
// ---------------------------------------------------------------------------

describe('planTeamFork — a carried terminal keeps its session', () => {
  const planDeps = (carry?: string[]): Parameters<typeof planTeamFork>[2] => ({
    newId: () => 'new-id',
    roleOf: () => undefined,
    ...(carry ? { carrySessions: new Set(carry) } : {})
  })

  it('carries every harness binding across, so the paste RESUMES', () => {
    const node = terminal('t1', {
      claudeSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      codexSessionRef: CODEX_REF,
      piSessionId: '019ffabf-2c8e-7f6d-b7f2-e09db7807349',
      opencodeSessionId: 'ses_abc123',
      sessionLineage: ['11111111-2222-4333-8444-555555555555']
    })
    const plan = planTeamFork(source([node]), { nodeIds: ['t1'], choices: [] }, planDeps(['t1']))
    const moved = plannedTerminal(plan)

    expect(moved.id).toBe('new-id') // a terminal still RE-IDs; only the session moves
    expect(moved.claudeSessionId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(moved.codexSessionRef).toBe(CODEX_REF)
    expect(moved.piSessionId).toBe('019ffabf-2c8e-7f6d-b7f2-e09db7807349')
    expect(moved.opencodeSessionId).toBe('ses_abc123')
    expect(moved.sessionLineage).toEqual(['11111111-2222-4333-8444-555555555555'])
  })

  it('is not a fork: no forkOf marker, so the rail shows one continuous agent', () => {
    const plan = planTeamFork(
      source([codexNode('t1')]),
      { nodeIds: ['t1'], choices: [] },
      planDeps(['t1'])
    )
    expect(plannedTerminal(plan).forkOf).toBeNull()
  })

  // The counterweight. Without this the "fix" would be to stop nulling refs
  // for everyone, which is the duplicate-in-place corruption the nulling was
  // added to prevent: two live processes appending to one rollout.
  it('a terminal NOT in the carry set still drops every binding (copy = fork)', () => {
    const node = terminal('t1', {
      claudeSessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      codexSessionRef: CODEX_REF,
      piSessionId: '019ffabf-2c8e-7f6d-b7f2-e09db7807349',
      opencodeSessionId: 'ses_abc123',
      sessionLineage: ['11111111-2222-4333-8444-555555555555']
    })
    const forked = plannedTerminal(
      planTeamFork(source([node]), { nodeIds: ['t1'], choices: [] }, planDeps())
    )
    expect(forked.claudeSessionId).toBeNull()
    expect(forked.codexSessionRef).toBeNull()
    expect(forked.piSessionId).toBeNull()
    expect(forked.opencodeSessionId).toBeNull()
    expect(forked.sessionLineage).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// copyTeam: the conversation and the LEDGER follow the card.
// ---------------------------------------------------------------------------

describe('copyTeam — a cut hands the conversation to the new id', () => {
  function copyDeps(): {
    deps: Parameters<typeof copyTeam>[0]
    store: WorkspaceStore
    carried: { from: TerminalNodeData; to: TerminalNodeData }[]
  } {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-carry-store-')))
    const carried: { from: TerminalNodeData; to: TerminalNodeData }[] = []
    const deps = {
      store,
      turns: { history: () => [] } as unknown as Parameters<typeof copyTeam>[0]['turns'],
      roles: { get: () => undefined } as unknown as Parameters<typeof copyTeam>[0]['roles'],
      teams: new TeamStore(mkdtempSync(path.join(tmpdir(), 'cookrew-carry-teams-'))),
      ptys: { get: () => undefined } as unknown as Parameters<typeof copyTeam>[0]['ptys'],
      switchWorkspace: (id: string) => void store.switchWorkspace(id),
      adoptNode: () => undefined,
      carrySession: (from: TerminalNodeData, to: TerminalNodeData) => void carried.push({ from, to }),
      git: {
        gitInfo: async () => ({
          isRepo: false,
          root: null,
          branch: null,
          dirty: false,
          ahead: 0,
          behind: 0
        }),
        addWorktree: async () => ({ ok: false as const, error: 'off' })
      },
      worktreeRoot: mkdtempSync(path.join(tmpdir(), 'cookrew-carry-wt-'))
    }
    return { deps, store, carried }
  }

  it('hands the source node and its new card to the carry, so the ledger follows', async () => {
    const { deps, store, carried } = copyDeps()
    const src = store.addNode(codexNode('src-codex'))
    const target = store.createWorkspace('Baymax Home', '/work/home')

    await copyTeam(deps, {
      nodeIds: [src.id],
      intoWorkspaceId: target.id,
      carrySessions: [src.id]
    })

    expect(carried).toHaveLength(1)
    expect(carried[0].from.id).toBe(src.id)
    expect(carried[0].to.id).not.toBe(src.id)
    // The new card lands in the TARGET's dir — that workdir change is the
    // only difference between this and a plain move, and it is exactly what
    // carrySessionToCwd is given the two cwds for.
    expect(carried[0].from.cwd).toBe('/work/repo')
    expect(carried[0].to.cwd).toBe('/work/home')
    expect(carried[0].to.codexSessionRef).toBe(CODEX_REF)
  })

  it('a plain COPY carries nothing — the source keeps running its session', async () => {
    const { deps, store, carried } = copyDeps()
    const src = store.addNode(codexNode('src-codex'))
    const target = store.createWorkspace('Baymax Home', '/work/home')

    await copyTeam(deps, { nodeIds: [src.id], intoWorkspaceId: target.id })

    expect(carried).toEqual([])
  })

  it('refuses to carry a session onto a node that has none — a note is not an agent', async () => {
    const { deps, store } = copyDeps()
    const src = store.addNode(codexNode('src-codex'))
    const target = store.createWorkspace('Baymax Home', '/work/home')

    await expect(
      copyTeam(deps, {
        nodeIds: [src.id],
        intoWorkspaceId: target.id,
        carrySessions: ['not-in-the-selection']
      })
    ).rejects.toThrow(/carry/i)
  })
})

// ---------------------------------------------------------------------------
// The clipboard: a CUT declares the move, and stops the source FIRST.
// ---------------------------------------------------------------------------

describe('TeamClipboard — cut declares a session move', () => {
  interface World {
    activeId: string
    workspaces: { meta: WorkspaceMeta; state: WorkspaceState }[]
    pastes: { carrySessions?: string[] }[]
    order: string[]
  }

  function fake(): { clip: TeamClipboard; world: World } {
    const nodes: CanvasNode[] = [
      codexNode('t1') as CanvasNode,
      terminal('t2') as CanvasNode,
      { kind: 'note', id: 'n1', name: 'Spec' } as unknown as CanvasNode
    ]
    const world: World = {
      activeId: 'A',
      workspaces: [
        {
          meta: { id: 'A', name: 'Alpha', dir: '/w', icon: '🗂' } as WorkspaceMeta,
          state: { name: 'Alpha', dir: '/w', dirs: ['/w'], nodes, connections: [] }
        },
        {
          meta: { id: 'B', name: 'Baymax Home', dir: '/w', icon: '🗂' } as WorkspaceMeta,
          state: { name: 'Baymax Home', dir: '/w', dirs: ['/w'], nodes: [], connections: [] }
        }
      ],
      pastes: [],
      order: []
    }
    const deps: TeamClipDeps = {
      activeId: () => world.activeId,
      workspaces: () => world.workspaces.map((w) => w.meta),
      workspaceState: (id) => {
        const hit = world.workspaces.find((w) => w.meta.id === id)
        if (!hit) throw new Error('no ws')
        return hit.state
      },
      activeNodes: () => world.workspaces.find((w) => w.meta.id === world.activeId)!.state.nodes,
      isWorking: () => false,
      paste: (spec) => {
        world.order.push('paste')
        world.pastes.push(spec)
        return Promise.resolve({
          workspaceId: 'B',
          workspaceName: 'Baymax Home',
          copiedNodes: 1,
          copiedCables: 0
        } as TeamCopyResult)
      },
      stopCut: async () => void world.order.push('stop'),
      removeCut: async () => void world.order.push('remove')
    }
    return { clip: new TeamClipboard(deps), world }
  }

  it('a CUT names the terminals whose sessions move', async () => {
    const { clip, world } = fake()
    clip.set(['t1', 't2', 'n1'], true)
    world.activeId = 'B'
    await clip.paste()
    expect(world.pastes[0].carrySessions?.sort()).toEqual(['t1', 't2'])
  })

  it('a COPY names none — the originals stay and keep their sessions', async () => {
    const { clip, world } = fake()
    clip.set(['t1', 't2'], false)
    world.activeId = 'B'
    await clip.paste()
    expect(world.pastes[0].carrySessions).toBeUndefined()
  })

  // Ordering, not decoration: a cut source in an inactive workspace is
  // DETACHED, not dead — the switch detaches panes, it does not kill them.
  // Adopting the copy first would resume the rollout while the original is
  // still appending to it.
  it('stops the source agents BEFORE the paste resumes their session', async () => {
    const { clip, world } = fake()
    clip.set(['t1'], true)
    world.activeId = 'B'
    await clip.paste()
    expect(world.order).toEqual(['stop', 'paste', 'remove'])
  })

  it('a COPY never stops anything', async () => {
    const { clip, world } = fake()
    clip.set(['t1'], false)
    world.activeId = 'B'
    await clip.paste()
    expect(world.order).toEqual(['paste'])
  })
})
