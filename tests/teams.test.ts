import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
  copyTeam,
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
    // The template picker's thumbnail: elements + the cable between them.
    expect(meta.preview?.items.map((i) => i.kind)).toEqual(['terminal', 'note'])
    expect(meta.preview?.cables).toEqual([{ a: 'a', b: 'n1' }])
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

  it('scopes a save to a selection: nodes, cables with both ends, turns (Figma model)', () => {
    const store = makeStore()
    const full: WorkspaceState = {
      name: 'Cookrew Dev',
      dir: '/work/repo',
      dirs: ['/work/repo'],
      nodes: [terminal('a'), terminal('b'), note('n1')],
      connections: [
        { id: 'cab', a: 'a', b: 'b' },
        { id: 'can', a: 'a', b: 'n1' }
      ]
    }
    const meta = store.save(full, (id) => (id === 'a' ? [turn(1)] : [turn(1), turn(2)]), 'Duo', [
      'a',
      'n1'
    ])
    expect(meta.nodeCount).toBe(2)
    expect(meta.terminalCount).toBe(1)
    const loaded = store.load('Duo')!
    expect(loaded.nodes.map((n) => n.id)).toEqual(['a', 'n1'])
    // cab reaches the unselected 'b' — a dangling cable must not travel.
    expect(loaded.connections.map((c) => c.id)).toEqual(['can'])
    // Only the selected terminal's history is snapshotted.
    expect(Object.keys(loaded.turns)).toEqual(['a'])
  })

  it('rejects a selection that matches nothing', () => {
    const store = makeStore()
    expect(() => store.save(state(), () => [], 'Ghost', ['nope'])).toThrow(/matched nothing/)
  })

  // THE LEADER (owner ruling, 2026-09-05): the first agent terminal the owner
  // selected leads the exported team; no orch node needed in the selection.
  it('stamps the FIRST SELECTED terminal as the team leader, demoting the workspace orch', () => {
    const store = makeStore()
    const orch = { ...terminal('conductor'), name: 'Conductor', orch: true }
    const full: WorkspaceState = {
      ...state(),
      nodes: [orch, terminal('a'), terminal('b'), note('n1')],
      connections: []
    }
    store.save(full, () => [], 'Led', ['n1', 'b', 'conductor', 'a'])
    const loaded = store.load('Led')!
    expect(loaded.entryAgent).toBe(loaded.nodes.find((n) => n.id === 'b')?.name)
    expect(
      loaded.nodes.filter((n) => n.kind === 'terminal').map((n) => [n.id, n.orch])
    ).toEqual([
      ['conductor', false],
      ['a', false],
      ['b', true]
    ])
    // The live workspace's own orch was not demoted by the save.
    expect(orch.orch).toBe(true)
  })

  it('a whole-workspace save (no selection) keeps the workspace orch as leader', () => {
    const store = makeStore()
    const full: WorkspaceState = {
      ...state(),
      nodes: [terminal('a'), { ...terminal('c'), name: 'Conductor', orch: true }],
      connections: []
    }
    store.save(full, () => [], 'Whole')
    const loaded = store.load('Whole')!
    expect(loaded.entryAgent).toBe('Conductor')
    expect(loaded.nodes.map((n) => (n.kind === 'terminal' ? n.orch : null))).toEqual([false, true])
  })

  it('migrates a leaderless legacy template: its entry agent becomes the orch', () => {
    const store = makeStore()
    store.save({ ...state(), nodes: [terminal('a'), terminal('b')], connections: [] }, () => [], 'Old', [
      'b',
      'a'
    ])
    // Strip what a pre-leader save never wrote.
    const file = path.join((store as unknown as { dir: string }).dir, 'old.json')
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    writeFileSync(
      file,
      JSON.stringify({
        ...raw,
        entryAgent: undefined,
        nodes: raw.nodes.map((n: { kind: string }) => (n.kind === 'terminal' ? { ...n, orch: false } : n))
      })
    )
    expect(store.migrateEntryAgents()).toBe(1)
    const loaded = store.load('Old')!
    expect(loaded.entryAgent).toBe(loaded.nodes[0].name)
    expect(loaded.nodes.map((n) => (n.kind === 'terminal' ? n.orch : null))).toEqual([true, false])
    // Idempotent: a second boot migrates nothing.
    expect(store.migrateEntryAgents()).toBe(0)
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

  it('starts Pi team forks with no inherited session binding or selector', () => {
    const src = source([
      terminal('pi', {
        preset: 'Pi', command: 'pi --model sonnet --session old-session -c',
        claudeSessionId: null, piSessionId: 'old-session'
      })
    ], { pi: [turn(1)] })
    const plan = planTeamFork(src, { nodeIds: ['pi'], choices: [] }, planDeps())
    const forked = plan.nodes[0] as TerminalNodeData

    expect(forked.command).toBe('pi --model sonnet')
    expect(forked.piSessionId).toBeNull()
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
    expect(on[0].worktreePath).toBe(path.join('/wt', 'repo'))
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
    expect(remap.get('/work/repo')).toBe(path.join('/wt', 'repo'))
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

  it('removes stale sidecars when the same team is saved with fewer agents', () => {
    const teamsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-teams-'))
    const projectsDir = mkdtempSync(path.join(tmpdir(), 'cookrew-teamsproj-'))
    const projectDir = path.join(projectsDir, claudeProjectSlug('/work/repo'))
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(path.join(projectDir, 'session-a.jsonl'), '{"sessionId":"session-a"}\n')
    writeFileSync(path.join(projectDir, 'session-b.jsonl'), '{"sessionId":"session-b"}\n')
    const store = new TeamStore(teamsDir, projectsDir)
    const a = terminal('a', { claudeSessionId: 'session-a' })
    const b = terminal('b', { claudeSessionId: 'session-b' })
    const state = (nodes: TerminalNodeData[]): WorkspaceState => ({
      name: 'Core',
      dir: '/work/repo',
      dirs: ['/work/repo'],
      nodes,
      connections: []
    })

    store.save(state([a, b]), () => [], 'Core')
    const sidecar = path.join(teamsDir, 'core-sessions')
    expect(existsSync(path.join(sidecar, 'b.jsonl'))).toBe(true)

    store.save(state([a]), () => [], 'Core')
    expect(existsSync(path.join(sidecar, 'a.jsonl'))).toBe(true)
    expect(existsSync(path.join(sidecar, 'b.jsonl'))).toBe(false)
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
    expect(store.focusedId).toBe(meta.id)
    const terminals = store.terminals()
    expect(terminals).toHaveLength(2)
    expect(terminals.every((t) => t.cwd === '/work/fresh')).toBe(true)
    expect(store.focusedState.connections).toHaveLength(1)
  })

  it('rejects an unknown template by name', async () => {
    const { deps } = templateDeps()
    await expect(
      workspaceFromTemplate(deps, { name: 'X', dir: '/work/fresh', team: 'Nope' })
    ).rejects.toThrow(/No saved team 'Nope'/)
  })
})

describe('copyTeam (Figma copy into an existing workspace)', () => {
  function copyDeps(history: TurnRecord[] = []): {
    deps: Parameters<typeof copyTeam>[0]
    store: WorkspaceStore
    adopted: CanvasNode[]
  } {
    const store = new WorkspaceStore(mkdtempSync(path.join(tmpdir(), 'cookrew-copy-store-')))
    const adopted: CanvasNode[] = []
    const deps = {
      store,
      turns: { history: () => history } as unknown as Parameters<typeof copyTeam>[0]['turns'],
      roles: { get: () => undefined } as unknown as Parameters<typeof copyTeam>[0]['roles'],
      teams: new TeamStore(mkdtempSync(path.join(tmpdir(), 'cookrew-copy-teams-'))),
      ptys: { get: () => undefined } as unknown as Parameters<typeof copyTeam>[0]['ptys'],
      switchWorkspace: (id: string) => void store.switchWorkspace(id),
      adoptNode: (n: CanvasNode) => void adopted.push(n),
      git: {
        gitInfo: async () => ({ isRepo: false, root: null, branch: null, dirty: false, ahead: 0, behind: 0 }),
        addWorktree: async () => ({ ok: false as const, error: 'off' })
      },
      worktreeRoot: mkdtempSync(path.join(tmpdir(), 'cookrew-copy-wt-'))
    }
    return { deps, store, adopted }
  }

  function seedSelection(store: WorkspaceStore): { aId: string; bId: string; noteId: string } {
    const a = store.addNode(terminal('src-a'))
    const b = store.addNode(terminal('src-b', { name: 'Sous' }))
    const n = store.addNode(note('src-n'))
    store.connect(a.id, b.id)
    store.connect(b.id, n.id)
    return { aId: a.id, bId: b.id, noteId: n.id }
  }

  it('appends copies + inner cables to an INACTIVE workspace without switching or booting', async () => {
    const { deps, store, adopted } = copyDeps()
    const { aId, bId } = seedSelection(store)
    const sourceWsId = store.focusedId
    const target = store.createWorkspace('Staging', '/work/staging')
    const events: string[] = []
    store.on('op', (event: { type: string }) => events.push(event.type))

    const result = await copyTeam(deps, { nodeIds: [aId, bId], intoWorkspaceId: target.id })
    expect(result).toMatchObject({
      workspaceId: target.id,
      workspaceName: 'Staging',
      copiedNodes: 2,
      copiedCables: 1
    })
    // No switch, no boot: inactive targets come alive on activation.
    expect(store.focusedId).toBe(sourceWsId)
    expect(adopted).toEqual([])

    const targetState = store.workspaceState(target.id)
    expect(targetState.nodes).toHaveLength(2)
    // Fresh ids — the source nodes stay untouched on their canvas.
    expect(targetState.nodes.map((n) => n.id)).not.toContain(aId)
    expect(store.focusedState.nodes).toHaveLength(3)
    // The a↔b cable traveled; the cable reaching the unselected note did not.
    expect(targetState.connections).toHaveLength(1)
    // Figma paste nudge, so a copy never lands pixel-exact on its source.
    expect(targetState.nodes[0].position).toEqual({ x: 42, y: 52 })
    // Copies adopt the TARGET's workdir: the source cwd (/work/repo) is not
    // in the target's dir list, so terminals land in the target primary and
    // the dir list itself is untouched.
    const copiedTerminals = targetState.nodes.filter(
      (n): n is TerminalNodeData => n.kind === 'terminal'
    )
    expect(copiedTerminals.every((t) => t.cwd === '/work/staging')).toBe(true)
    expect(store.workspaceState(target.id).dirs).toEqual(['/work/staging'])
    // teamPaste records one grouped summary after copyTeam returns. The copy
    // engine itself must not emit one event per appended node/cable.
    expect(events).toEqual([])
  })

  it('refuses to copy WORKING agents, by name', async () => {
    const { deps, store } = copyDeps()
    const { aId, bId } = seedSelection(store)
    const target = store.createWorkspace('Staging', '/work/staging')
    const guarded = { ...deps, isWorking: (id: string) => id === aId }
    await expect(
      copyTeam(guarded, { nodeIds: [aId, bId], intoWorkspaceId: target.id })
    ).rejects.toThrow(/Working agents can't be copied — wait for “Agent src-a”/)
  })

  it('pastes from an INACTIVE source workspace (fromWorkspaceId, post-switch)', async () => {
    const { deps, store, adopted } = copyDeps()
    const { aId, bId } = seedSelection(store)
    const sourceWsId = store.focusedId
    const target = store.createWorkspace('Staging', '/work/staging')
    store.switchWorkspace(target.id)

    const result = await copyTeam(deps, {
      nodeIds: [aId, bId],
      intoWorkspaceId: target.id,
      fromWorkspaceId: sourceWsId
    })
    expect(result.copiedNodes).toBe(2)
    expect(result.copiedCables).toBe(1)
    // Landed on the now-active canvas: adopted (booted) and re-homed to the
    // target's workdir; the source workspace keeps its originals.
    expect(adopted).toHaveLength(2)
    const copied = store.focusedState.nodes.filter((n): n is TerminalNodeData => n.kind === 'terminal')
    expect(copied.every((t) => t.cwd === '/work/staging')).toBe(true)
    expect(store.workspaceState(sourceWsId).nodes).toHaveLength(3)
  })

  it('copy into the ACTIVE workspace duplicates in place and adopts every node', async () => {
    const { deps, store, adopted } = copyDeps()
    const { aId } = seedSelection(store)
    const web = store.addNode({
      kind: 'browser',
      id: 'src-web',
      name: 'Docs',
      url: 'https://example.com',
      position: { x: 900, y: 20 },
      size: { width: 400, height: 300 }
    })

    let changes = 0
    const events: string[] = []
    store.on('change', () => {
      changes += 1
    })
    store.on('op', (event: { type: string }) => events.push(event.type))
    const result = await copyTeam(deps, {
      nodeIds: [aId, web.id],
      intoWorkspaceId: store.focusedId
    })
    expect(result.copiedNodes).toBe(2)
    // EVERY kind is adopted (terminals spawn, browsers sync) — not just
    // terminals; a copied browser must not render as a dead card.
    expect(adopted.map((n) => n.kind).sort()).toEqual(['browser', 'terminal'])
    // The duplicate gets a unique name next to its source.
    const names = store.focusedState.nodes.map((n) => n.name)
    expect(new Set(names).size).toBe(names.length)
    expect(changes).toBe(1)
    expect(events).toEqual([])
  })

  it('NEVER carries a harness session binding onto the copy', async () => {
    const { deps, store } = copyDeps()
    const src = store.addNode(
      terminal('src-bound', {
        command: 'codex',
        claudeSessionId: 'sess-1',
        codexSessionRef: '/rollouts/live.jsonl',
        opencodeSessionId: 'oc-1',
        piSessionId: 'pi-1',
        sessionLineage: ['sess-0'],
        restoreStack: [{ rewoundToIndex: 1 } as never]
      })
    )
    const target = store.createWorkspace('Staging', '/work/staging')
    await copyTeam(deps, { nodeIds: [src.id], intoWorkspaceId: target.id })

    const copy = store.workspaceState(target.id).nodes[0] as TerminalNodeData
    // An inherited codexSessionRef would `codex resume` the SOURCE's live
    // rollout — two processes appending to one session file.
    expect(copy.claudeSessionId).toBeNull()
    expect(copy.codexSessionRef).toBeNull()
    expect(copy.opencodeSessionId).toBeNull()
    expect(copy.piSessionId).toBeNull()
    expect(copy.sessionLineage).toBeUndefined()
    expect(copy.restoreStack).toBeUndefined()
  })

  it('stashes the context preamble for INACTIVE targets (pendingInject)', async () => {
    const { deps, store } = copyDeps([turn(1)])
    const src = store.addNode(terminal('src-codex', { command: 'codex' }))
    const target = store.createWorkspace('Staging', '/work/staging')
    await copyTeam(deps, { nodeIds: [src.id], intoWorkspaceId: target.id })

    // A preamble-based agent (codex) cannot be injected into a PTY that
    // does not exist yet — the switch boot delivers this later. Without it
    // the copy would boot fresh while wearing a forkOf badge.
    const copy = store.workspaceState(target.id).nodes[0] as TerminalNodeData
    expect(copy.pendingInject).toEqual(expect.stringContaining('prompt 1'))
  })

  it('preserveIdentity MOVES notes/browsers: same id, same position, cables re-homed', async () => {
    const { deps, store } = copyDeps()
    const a = store.addNode(terminal('src-a'))
    const n = store.addNode(note('src-n'))
    store.connect(a.id, n.id)
    const target = store.createWorkspace('Staging', '/work/staging')

    await copyTeam(deps, {
      nodeIds: [a.id, n.id],
      intoWorkspaceId: target.id,
      preserveIdentity: [n.id]
    })
    const state = store.workspaceState(target.id)
    const movedNote = state.nodes.find((x) => x.kind === 'note')
    const copiedAgent = state.nodes.find((x) => x.kind === 'terminal')
    // The note is the SAME card (id + position); the agent re-ids.
    expect(movedNote?.id).toBe(n.id)
    expect(movedNote?.position).toEqual(n.position)
    expect(copiedAgent?.id).not.toBe(a.id)
    // The cable between them survived, re-homed onto the copied agent.
    expect(state.connections).toHaveLength(1)
    expect([state.connections[0].a, state.connections[0].b].sort()).toEqual(
      [copiedAgent?.id, n.id].sort()
    )
  })

  it('terminals can never transfer identity', async () => {
    const { deps, store } = copyDeps()
    const { aId } = seedSelection(store)
    const target = store.createWorkspace('Staging', '/work/staging')
    await expect(
      copyTeam(deps, { nodeIds: [aId], intoWorkspaceId: target.id, preserveIdentity: [aId] })
    ).rejects.toThrow(/Terminals can't transfer identity/)
  })

  it('spawns copies into a FRESH named worktree when requested', async () => {
    const { deps, store } = copyDeps()
    const { aId, bId } = seedSelection(store)
    const target = store.createWorkspace('Staging', '/work/staging')
    const added: string[][] = []
    const gitDeps = {
      ...deps,
      git: {
        gitInfo: async () => ({ isRepo: true, root: '/work/repo', branch: 'main', dirty: false, ahead: 0, behind: 0 }),
        addWorktree: async (repo: string, wt: string, branch: string) => {
          added.push([repo, wt, branch])
          return { ok: true as const, path: wt }
        }
      }
    }
    await copyTeam(gitDeps, {
      nodeIds: [aId, bId],
      intoWorkspaceId: target.id,
      worktree: { name: 'Fix Attempt' }
    })
    // One worktree of the shared repo dir, named branch, slugged path — the
    // path goes through path.join, so compare platform-joined, not with a
    // hard-coded '/': on Windows the separator is a backslash.
    expect(added).toHaveLength(1)
    expect(added[0][0]).toBe('/work/repo')
    expect(added[0][1]).toBe(path.join(deps.worktreeRoot, 'fix-attempt'))
    expect(added[0][2]).toBe('cookrew/fix-attempt')
    // Every copied agent lands IN the worktree, and the target lists it.
    const state = store.workspaceState(target.id)
    const copied = state.nodes.filter((n): n is TerminalNodeData => n.kind === 'terminal')
    expect(copied.map((t) => t.cwd)).toEqual([added[0][1], added[0][1]])
    expect(state.dirs).toContain(added[0][1])
  })

  it('worktree paste fails LOUDLY — never the silent in-place fallback', async () => {
    const { deps, store } = copyDeps()
    const { aId } = seedSelection(store)
    const target = store.createWorkspace('Staging', '/work/staging')
    // Not a repo → refuse.
    await expect(
      copyTeam(deps, { nodeIds: [aId], intoWorkspaceId: target.id, worktree: { name: 'x' } })
    ).rejects.toThrow(/is not a git repo/)
    // Repo, but the worktree add fails (e.g. name taken) → refuse, by reason.
    const failing = {
      ...deps,
      git: {
        gitInfo: async () => ({ isRepo: true, root: '/work/repo', branch: 'main', dirty: false, ahead: 0, behind: 0 }),
        addWorktree: async () => ({ ok: false as const, error: 'branch exists' })
      }
    }
    await expect(
      copyTeam(failing, { nodeIds: [aId], intoWorkspaceId: target.id, worktree: { name: 'x' } })
    ).rejects.toThrow(/branch exists — pick a fresh name/)
    // Agents across two workdirs cannot share one worktree.
    const b2 = store.addNode(terminal('src-c', { cwd: '/work/other' }))
    await expect(
      copyTeam(failing, {
        nodeIds: [aId, b2.id],
        intoWorkspaceId: target.id,
        worktree: { name: 'x' }
      })
    ).rejects.toThrow(/ONE workdir/)
    // Nothing was pasted by any of the refusals.
    expect(store.workspaceState(target.id).nodes).toHaveLength(0)
  })

  it('rejects an unknown target workspace and malformed specs', async () => {
    const { deps, store } = copyDeps()
    const { aId } = seedSelection(store)
    await expect(copyTeam(deps, { nodeIds: [aId], intoWorkspaceId: 'nope' })).rejects.toThrow(
      /No workspace 'nope'/
    )
    await expect(
      copyTeam(deps, { nodeIds: 'evil' as unknown as string[], intoWorkspaceId: store.focusedId })
    ).rejects.toThrow(/string\[\]/)
    // A stale selection speaks copy, not fork.
    await expect(
      copyTeam(deps, { nodeIds: ['ghost'], intoWorkspaceId: store.focusedId })
    ).rejects.toThrow(/^Team copy needs at least one selected node/)
  })
})
