import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AgentRole,
  CanvasNode,
  NoteNodeData,
  TerminalNodeData,
  WorkspaceState
} from '../src/shared/model'
import type { TurnRecord } from '../src/shared/turn'
import { WorkspaceStore } from '../src/main/store'
import { claudeProjectSlug } from '../src/shared/claude-fork'
import {
  TeamStore,
  applyWorktreeRemap,
  planTeamFork,
  planWorktrees,
  resolveTerminalContext,
  resolveWorktrees,
  workspaceFromTemplate,
  type TeamForkSource
} from '../src/main/teams'

const T0 = Date.parse('2026-07-20T10:00:00.000Z')

function turn(index: number, overrides: Partial<TurnRecord> = {}): TurnRecord {
  return {
    index,
    prompt: `prompt ${index}`,
    reply: `reply ${index}`,
    startedAt: T0 + index * 60_000,
    endedAt: T0 + index * 60_000 + 30_000,
    ...overrides
  }
}

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

function note(id: string): NoteNodeData {
  return {
    kind: 'note',
    id,
    name: 'Spec',
    customName: null,
    content: '# spec body',
    locked: false,
    position: { x: 500, y: 20 },
    size: { width: 300, height: 200 }
  }
}

const ROLE: AgentRole = {
  name: 'Backend Dev',
  preset: 'Codex',
  command: 'codex',
  rolePrompt: 'You are a backend developer.',
  savedAt: T0
}

function source(
  nodes: CanvasNode[],
  turnsById: Record<string, TurnRecord[]> = {},
  dirs: string[] = ['/work/repo']
): TeamForkSource {
  return {
    name: 'Cookrew Dev',
    dir: dirs[0],
    dirs,
    nodes,
    connections: [],
    turnsOf: (id) => turnsById[id] ?? [],
    fromSnapshot: false
  }
}

function planDeps(): { newId: () => string; roleOf: (name: string) => AgentRole | undefined } {
  let n = 0
  return {
    newId: () => `new-${(n += 1)}`,
    roleOf: (name) => (name.toLowerCase() === ROLE.name.toLowerCase() ? ROLE : undefined)
  }
}

describe('TeamStore', () => {
  function makeStore(): TeamStore {
    return new TeamStore(mkdtempSync(path.join(tmpdir(), 'cookrew-teams-')))
  }

  function state(): WorkspaceState {
    return {
      name: 'Cookrew Dev',
      dir: '/work/repo',
      dirs: ['/work/repo'],
      nodes: [terminal('a'), note('n1')],
      connections: [{ id: 'c1', a: 'a', b: 'n1' }]
    }
  }

  it('saves a snapshot with per-terminal turn histories and lists it', () => {
    const store = makeStore()
    const meta = store.save(state(), (id) => (id === 'a' ? [turn(1), turn(2)] : []))
    expect(meta.name).toBe('Cookrew Dev')
    expect(meta.nodeCount).toBe(2)
    expect(meta.terminalCount).toBe(1)
    expect(store.list()).toHaveLength(1)

    const loaded = store.load('cookrew dev')
    expect(loaded).toBeDefined()
    expect(loaded!.turns['a']).toHaveLength(2)
    expect(loaded!.connections).toHaveLength(1)
  })

  it('overwrites the same name and honors an explicit name', () => {
    const store = makeStore()
    store.save(state(), () => [], 'Alpha Team')
    store.save(state(), () => [turn(1)], 'Alpha Team')
    expect(store.list()).toHaveLength(1)
    expect(store.load('Alpha Team')!.turns['a']).toHaveLength(1)
  })
})

describe('planTeamFork', () => {
  it('remaps ids, keeps layout, drops excluded nodes and dangling connections', () => {
    const src: TeamForkSource = {
      ...source([terminal('a'), terminal('b'), note('n1')], { a: [turn(1)] }),
      connections: [
        { id: 'c1', a: 'a', b: 'n1' },
        { id: 'c2', a: 'a', b: 'b' }
      ]
    }
    const plan = planTeamFork(src, { nodeIds: ['a', 'n1'], choices: [] }, planDeps())

    expect(plan.nodes).toHaveLength(2)
    expect(plan.nodes.every((n) => !['a', 'b', 'n1'].includes(n.id))).toBe(true)
    expect(plan.nodes.find((n) => n.kind === 'note')?.position).toEqual({ x: 500, y: 20 })
    // Only the a↔n1 edge survives (b excluded), remapped to the new ids.
    expect(plan.connections).toHaveLength(1)
    expect(plan.name).toBe('Cookrew Dev fork')
  })

  it('defaults terminals to latest, resolves first, and strips session flags', () => {
    const src = source(
      [terminal('a', { command: 'claude --resume old-id', claudeSessionId: 'old-id' })],
      { a: [turn(3), turn(4)] }
    )
    const latest = planTeamFork(src, { nodeIds: ['a'], choices: [] }, planDeps())
    expect(latest.terminals[0].mode).toBe('latest')
    expect(latest.terminals[0].turnIndex).toBe(4)

    const first = planTeamFork(
      src,
      { nodeIds: ['a'], choices: [{ nodeId: 'a', mode: 'first' }] },
      planDeps()
    )
    expect(first.terminals[0].turnIndex).toBe(3)

    const forked = latest.nodes[0] as TerminalNodeData
    expect(forked.command).toBe('claude')
    expect(forked.claudeSessionId).toBeNull()
    expect(forked.forkOf?.turnIndex).toBe(4)
  })

  it('validates assembled picks and missing roles', () => {
    const src = source([terminal('a')], { a: [turn(1)] })
    expect(() =>
      planTeamFork(
        src,
        { nodeIds: ['a'], choices: [{ nodeId: 'a', mode: 'assembled', turnIndexes: [9] }] },
        planDeps()
      )
    ).toThrow(/none of the selected turns/i)
    expect(() =>
      planTeamFork(
        src,
        { nodeIds: ['a'], choices: [{ nodeId: 'a', mode: 'role', roleName: 'Nope' }] },
        planDeps()
      )
    ).toThrow(/No saved role/)
  })

  it('role mode adopts the role preset/command and drops fork lineage', () => {
    const src = source([terminal('a')], { a: [turn(1)] })
    const plan = planTeamFork(
      src,
      { nodeIds: ['a'], choices: [{ nodeId: 'a', mode: 'role', roleName: 'backend dev' }] },
      planDeps()
    )
    const forked = plan.nodes[0] as TerminalNodeData
    expect(forked.preset).toBe('Codex')
    expect(forked.command).toBe('codex')
    expect(forked.role).toBe('Backend Dev')
    expect(forked.forkOf).toBeNull()
  })

  it('rejects an empty selection', () => {
    expect(() => planTeamFork(source([]), { nodeIds: [], choices: [] }, planDeps())).toThrow(
      /at least one/
    )
  })
})

describe('resolveTerminalContext', () => {
  function planFor(
    src: TeamForkSource,
    choices: Parameters<typeof planTeamFork>[1]['choices']
  ): ReturnType<typeof planTeamFork>['terminals'][0] {
    return planTeamFork(src, { nodeIds: src.nodes.map((n) => n.id), choices }, planDeps())
      .terminals[0]
  }

  it('role mode injects the role boot message', () => {
    const plan = planFor(source([terminal('a')]), [
      { nodeId: 'a', mode: 'role', roleName: 'Backend Dev' }
    ])
    const ctx = resolveTerminalContext(plan, { fromSnapshot: false })
    expect(ctx.claudeSessionId).toBeNull()
    expect(ctx.inject).toContain('[Cookrew role: Backend Dev]')
    expect(ctx.inject).toContain('backend developer')
  })

  it('assembled mode replays exactly the picked turns', () => {
    const plan = planFor(source([terminal('a')], { a: [turn(1), turn(2), turn(3)] }), [
      { nodeId: 'a', mode: 'assembled', turnIndexes: [3, 1] }
    ])
    const ctx = resolveTerminalContext(plan, { fromSnapshot: false })
    expect(ctx.inject).toContain('prompt 3')
    expect(ctx.inject).toContain('prompt 1')
    expect(ctx.inject).not.toContain('prompt 2')
    expect(ctx.claudeSessionId).toBeNull()
  })

  it('injects nothing for a terminal with no turns yet', () => {
    const plan = planFor(source([terminal('a')]), [])
    expect(resolveTerminalContext(plan, { fromSnapshot: false })).toEqual({ inject: null, claudeSessionId: null })
  })

  it('falls back to preamble replay when forking a saved snapshot', () => {
    const plan = planFor(source([terminal('a')], { a: [turn(1), turn(2)] }), [])
    const ctx = resolveTerminalContext(plan, { fromSnapshot: true })
    expect(ctx.claudeSessionId).toBeNull()
    expect(ctx.inject).toContain('── Turn 2 ──')
  })

  it('natively forks a live Claude terminal with a bound session file', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-team-native-'))
    const dir = path.join(projectsDir, claudeProjectSlug('/work/repo'))
    mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({
      type: 'user',
      sessionId: 'bound-id',
      timestamp: new Date(T0 + 60_000).toISOString(),
      message: { role: 'user', content: 'prompt 1' }
    })
    writeFileSync(path.join(dir, 'bound-id.jsonl'), `${line}\n`)

    const plan = planFor(
      source([terminal('a', { claudeSessionId: 'bound-id' })], { a: [turn(1)] }),
      []
    )
    const ctx = resolveTerminalContext(plan, { fromSnapshot: false }, projectsDir)
    expect(ctx.claudeSessionId).not.toBeNull()
    expect(ctx.inject).toContain('branched after its turn 1')
    expect(ctx.inject).not.toContain('── Turn 1 ──')
  })
})

describe('team fork by directory + worktree (GOAL 3/5)', () => {
  it('lands a forked terminal in its chosen targetDir', () => {
    const src = source([terminal('a', { cwd: '/work/repo' })], { a: [turn(1)] }, ['/work/repo', '/work/api'])
    const plan = planTeamFork(
      src,
      { nodeIds: ['a'], choices: [{ nodeId: 'a', mode: 'latest', targetDir: '/work/api' }] },
      planDeps()
    )
    expect(plan.terminals[0].targetDir).toBe('/work/api')
    expect((plan.nodes[0] as TerminalNodeData).cwd).toBe('/work/api')
    expect(plan.dirs).toEqual(['/work/repo', '/work/api'])
  })

  it('defaults a terminal to its source cwd, else the primary', () => {
    const src = source([terminal('a', { cwd: '/work/api' })], {}, ['/work/repo', '/work/api'])
    const keep = planTeamFork(src, { nodeIds: ['a'], choices: [] }, planDeps())
    expect(keep.terminals[0].targetDir).toBe('/work/api')

    const src2 = source([terminal('b', { cwd: '/gone' })], {}, ['/work/repo'])
    const snap = planTeamFork(src2, { nodeIds: ['b'], choices: [] }, planDeps())
    expect(snap.terminals[0].targetDir).toBe('/work/repo')
  })

  it('overrides the forked workspace dir set from spec.dirs', () => {
    const src = source([terminal('a')], {}, ['/work/repo'])
    const plan = planTeamFork(
      src,
      { nodeIds: ['a'], choices: [], dirs: ['/work/repo', '/extra'] },
      planDeps()
    )
    expect(plan.dirs).toEqual(['/work/repo', '/extra'])
  })

  it('planWorktrees only targets repo dirs when enabled', () => {
    const isRepo = (d: string): boolean => d === '/work/repo'
    const on = planWorktrees(['/work/repo', '/work/docs'], isRepo, {
      enabled: true,
      worktreeRoot: '/wt',
      branch: 'cookrew/fork'
    })
    expect(on).toHaveLength(1)
    expect(on[0].repoDir).toBe('/work/repo')
    expect(on[0].worktreePath).toBe('/wt/repo')
    expect(planWorktrees(['/work/repo'], isRepo, { enabled: false, worktreeRoot: '/wt', branch: 'b' })).toEqual([])
  })

  it('resolveWorktrees remaps successful adds and keeps failures in place', async () => {
    const api = {
      gitInfo: async (dir: string) => ({
        isRepo: dir !== '/plain',
        root: dir,
        branch: 'main',
        dirty: false,
        ahead: 0,
        behind: 0
      }),
      addWorktree: async (repoDir: string, worktreePath: string) =>
        repoDir === '/work/bad'
          ? ({ ok: false as const, error: 'boom' })
          : ({ ok: true as const, path: worktreePath })
    }
    const { remap, errors } = await resolveWorktrees(api, ['/work/repo', '/work/bad', '/plain'], {
      enabled: true,
      worktreeRoot: '/wt',
      branch: 'cookrew/fork'
    })
    expect(remap.get('/work/repo')).toBe('/wt/repo')
    expect(remap.has('/work/bad')).toBe(false)
    expect(remap.has('/plain')).toBe(false)
    expect(errors[0]).toContain('/work/bad')
  })

  it('applyWorktreeRemap repoints dirs and terminal cwds', () => {
    const src = source([terminal('a', { cwd: '/work/repo' })], { a: [turn(1)] }, ['/work/repo'])
    const plan = planTeamFork(src, { nodeIds: ['a'], choices: [] }, planDeps())
    const remapped = applyWorktreeRemap(plan, new Map([['/work/repo', '/wt/repo']]))
    expect(remapped.dirs).toEqual(['/wt/repo'])
    expect((remapped.nodes[0] as TerminalNodeData).cwd).toBe('/wt/repo')
    expect(remapped.terminals[0].targetDir).toBe('/wt/repo')
  })
})

describe('resolveTerminalContext — native checkpoint assembly (item 2a)', () => {
  function planFor(
    src: TeamForkSource,
    choices: Parameters<typeof planTeamFork>[1]['choices']
  ): ReturnType<typeof planTeamFork>['terminals'][0] {
    return planTeamFork(src, { nodeIds: src.nodes.map((n) => n.id), choices }, planDeps())
      .terminals[0]
  }

  function sessionLine(i: number, sessionId = 'bound-id'): string {
    return JSON.stringify({
      type: 'user',
      uuid: `u${i}`,
      sessionId,
      timestamp: new Date(T0 + i * 60_000).toISOString(),
      message: { role: 'user', content: `prompt ${i}` }
    })
  }

  function replyLine(i: number, sessionId = 'bound-id'): string {
    return JSON.stringify({
      type: 'assistant',
      uuid: `a${i}`,
      sessionId,
      timestamp: new Date(T0 + i * 60_000 + 20_000).toISOString(),
      message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i}` }] }
    })
  }

  it('assembles NATIVELY from uuid ranges when the session is bound', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-asm-'))
    const dir = path.join(projectsDir, claudeProjectSlug('/work/repo'))
    mkdirSync(dir, { recursive: true })
    const lines = [1, 2, 3].flatMap((i) => [sessionLine(i), replyLine(i)])
    writeFileSync(path.join(dir, 'bound-id.jsonl'), lines.join('\n') + '\n')

    const history = [
      turn(1, { uuid: 'u1' }),
      turn(2, { uuid: 'u2' }),
      turn(3, { uuid: 'u3' })
    ]
    const plan = planFor(source([terminal('a', { claudeSessionId: 'bound-id' })], { a: history }), [
      { nodeId: 'a', mode: 'assembled', turnIndexes: [1, 3] }
    ])
    const ctx = resolveTerminalContext(plan, { fromSnapshot: false }, projectsDir)

    expect(ctx.claudeSessionId).not.toBeNull()
    // Native: short assembled notice, NOT a transcript replay.
    expect(ctx.inject).toContain('checkpoints T1, T3')
    expect(ctx.inject).not.toContain('── Turn 1 ──')
    // The forked session file holds exactly the selected ranges, in the
    // TARGET dir's project folder.
    const forkFile = path.join(
      projectsDir,
      claudeProjectSlug(plan.targetDir),
      `${ctx.claudeSessionId}.jsonl`
    )
    const forked = readFileSync(forkFile, 'utf8')
    expect(forked).toContain('prompt 1')
    expect(forked).toContain('prompt 3')
    expect(forked).not.toContain('prompt 2')
  })

  it('falls back to assembled preamble when records lack uuids (Codex/legacy)', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-asm-'))
    const plan = planFor(source([terminal('a')], { a: [turn(1), turn(2)] }), [
      { nodeId: 'a', mode: 'assembled', turnIndexes: [2] }
    ])
    const ctx = resolveTerminalContext(plan, { fromSnapshot: false }, projectsDir)
    expect(ctx.claudeSessionId).toBeNull()
    expect(ctx.inject).toContain('── Turn 2 ──')
  })
})

describe('resolveTerminalContext — snapshot native rewind (item 2b)', () => {
  function planFor(
    src: TeamForkSource,
    choices: Parameters<typeof planTeamFork>[1]['choices']
  ): ReturnType<typeof planTeamFork>['terminals'][0] {
    return planTeamFork(src, { nodeIds: src.nodes.map((n) => n.id), choices }, planDeps())
      .terminals[0]
  }

  const snapLines = [
    JSON.stringify({
      type: 'user',
      uuid: 'u1',
      sessionId: 'old-id',
      timestamp: new Date(T0 + 60_000).toISOString(),
      message: { role: 'user', content: 'prompt 1' }
    }),
    JSON.stringify({
      type: 'user',
      uuid: 'u2',
      sessionId: 'old-id',
      timestamp: new Date(T0 + 120_000).toISOString(),
      message: { role: 'user', content: 'prompt 2' }
    })
  ]

  it('native-rewinds a saved team from its session sidecar in a fresh dir', () => {
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-snapnative-'))
    const history = [turn(1, { uuid: 'u1' }), turn(2, { uuid: 'u2' })]
    const plan = planFor(source([terminal('a')], { a: history }), [
      { nodeId: 'a', mode: 'first' }
    ])
    const ctx = resolveTerminalContext(
      plan,
      { fromSnapshot: true, sessionLinesOf: () => snapLines },
      projectsDir
    )
    expect(ctx.claudeSessionId).not.toBeNull()
    expect(ctx.inject).toContain('branched after its turn 1')
    const forkFile = path.join(
      projectsDir,
      claudeProjectSlug(plan.targetDir),
      `${ctx.claudeSessionId}.jsonl`
    )
    const forked = readFileSync(forkFile, 'utf8')
    expect(forked).toContain('prompt 1')
    expect(forked).not.toContain('prompt 2')
    expect(forked).not.toContain('old-id')
  })

  it('keeps the preamble fallback for snapshots without sidecars', () => {
    const plan = planFor(source([terminal('a')], { a: [turn(1)] }), [])
    const ctx = resolveTerminalContext(plan, { fromSnapshot: true, sessionLinesOf: () => null })
    expect(ctx.claudeSessionId).toBeNull()
    expect(ctx.inject).toContain('── Turn 1 ──')
  })
})

describe('TeamStore session snapshots (item 2b save path)', () => {
  it('copies bound session files into the sidecar and serves their lines', () => {
    const teamsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-teams-'))
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-teamsproj-'))
    const dir = path.join(projectsDir, claudeProjectSlug('/work/repo'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'bound-id.jsonl'), '{"type":"mode","sessionId":"bound-id"}\n')

    const store = new TeamStore(teamsDir, projectsDir)
    const node = terminal('a', { claudeSessionId: 'bound-id' })
    const state = {
      name: 'Core',
      dir: '/work/repo',
      dirs: ['/work/repo'],
      nodes: [node],
      connections: []
    }
    store.save(state, () => [turn(1)], 'Core')

    const snap = store.load('Core')
    expect(snap?.sessions?.a).toBe('a.jsonl')
    const lines = store.sessionLines(snap!, 'a')
    expect(lines?.join('\n')).toContain('bound-id')
    // Terminals without a bound session simply have no sidecar entry.
    expect(store.sessionLines(snap!, 'missing')).toBeNull()
  })
})

describe('planTeamFork selection semantics (BUG 1: picker saved-team payload)', () => {
  it('empty nodeIds on a SNAPSHOT source means the whole saved team', () => {
    const snap = { ...source([terminal('a'), terminal('b')], { a: [turn(1)] }), fromSnapshot: true }
    const plan = planTeamFork(snap, { nodeIds: [], choices: [], fromSavedTeam: 'Core' }, planDeps())
    expect(plan.nodes).toHaveLength(2)
    expect(plan.terminals).toHaveLength(2)
  })

  it('still rejects an empty LIVE selection, echoing the received spec shape', () => {
    const live = source([terminal('a')])
    expect(() => planTeamFork(live, { nodeIds: [], choices: [] }, planDeps())).toThrow(
      /received nodeIds=\[\].*source has 1 node/
    )
  })

  it('echoes stale ids that match nothing in the snapshot', () => {
    const snap = { ...source([terminal('a')]), fromSnapshot: true }
    expect(() =>
      planTeamFork(
        snap,
        { nodeIds: ['live-1', 'live-2'], choices: [], fromSavedTeam: 'Core' },
        planDeps()
      )
    ).toThrow(/live-1.*fromSavedTeam="Core".*source has 1 node/)
  })
})

describe('workspaceFromTemplate (FEATURE 1: workspace from team template)', () => {
  function templateDeps(): {
    deps: Parameters<typeof workspaceFromTemplate>[0]
    store: WorkspaceStore
    teams: TeamStore
  } {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-tmpl-store-')))
    const teams = new TeamStore(mkdtempSync(path.join(tmpdir(), 'cookrew-tmpl-teams-')))
    const deps = {
      store,
      turns: { history: () => [] } as unknown as Parameters<typeof workspaceFromTemplate>[0]['turns'],
      roles: { get: () => undefined } as unknown as Parameters<typeof workspaceFromTemplate>[0]['roles'],
      teams,
      ptys: { get: () => undefined } as unknown as Parameters<typeof workspaceFromTemplate>[0]['ptys'],
      switchWorkspace: (id: string) => void store.switchWorkspace(id),
      git: {
        gitInfo: async () => ({ isRepo: false, root: null, branch: null, dirty: false, ahead: 0, behind: 0 }),
        addWorktree: async () => ({ ok: false as const, error: 'off' })
      },
      worktreeRoot: mkdtempSync(path.join(tmpdir(), 'cookrew-tmpl-wt-'))
    }
    return { deps, store, teams }
  }

  it('boots a new workspace pre-populated from the whole saved template', async () => {
    const { deps, store, teams } = templateDeps()
    teams.save(
      {
        name: 'Core Team',
        dir: '/work/old',
        dirs: ['/work/old'],
        nodes: [terminal('a'), terminal('b', { name: 'Sous' })],
        connections: [{ id: 'c1', a: 'a', b: 'b' }]
      },
      () => [turn(1)],
      'Core Team'
    )

    const meta = await workspaceFromTemplate(deps, {
      name: 'Sprint 9',
      dir: '/work/fresh',
      team: 'Core Team'
    })
    expect(meta.name).toBe('Sprint 9')
    // Switched into the new workspace: full team, retargeted dir, edges kept.
    expect(store.activeId).toBe(meta.id)
    const terminals = store.terminals()
    expect(terminals).toHaveLength(2)
    expect(terminals.every((t) => t.cwd === '/work/fresh')).toBe(true)
    expect(store.state.connections).toHaveLength(1)
  })

  it('rejects an unknown template by name', async () => {
    const { deps } = templateDeps()
    await expect(
      workspaceFromTemplate(deps, { name: 'X', dir: '/work/fresh', team: 'Nope' })
    ).rejects.toThrow(/No saved team 'Nope'/)
  })
})
