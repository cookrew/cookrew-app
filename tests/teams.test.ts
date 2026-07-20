import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
import { claudeProjectSlug } from '../src/shared/claude-fork'
import {
  TeamStore,
  planTeamFork,
  resolveTerminalContext,
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

function source(nodes: CanvasNode[], turnsById: Record<string, TurnRecord[]> = {}): TeamForkSource {
  return {
    name: 'Cookrew Dev',
    dir: '/work/repo',
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
    const ctx = resolveTerminalContext(plan, false)
    expect(ctx.claudeSessionId).toBeNull()
    expect(ctx.inject).toContain('[Cookrew role: Backend Dev]')
    expect(ctx.inject).toContain('backend developer')
  })

  it('assembled mode replays exactly the picked turns', () => {
    const plan = planFor(source([terminal('a')], { a: [turn(1), turn(2), turn(3)] }), [
      { nodeId: 'a', mode: 'assembled', turnIndexes: [3, 1] }
    ])
    const ctx = resolveTerminalContext(plan, false)
    expect(ctx.inject).toContain('prompt 3')
    expect(ctx.inject).toContain('prompt 1')
    expect(ctx.inject).not.toContain('prompt 2')
    expect(ctx.claudeSessionId).toBeNull()
  })

  it('injects nothing for a terminal with no turns yet', () => {
    const plan = planFor(source([terminal('a')]), [])
    expect(resolveTerminalContext(plan, false)).toEqual({ inject: null, claudeSessionId: null })
  })

  it('falls back to preamble replay when forking a saved snapshot', () => {
    const plan = planFor(source([terminal('a')], { a: [turn(1), turn(2)] }), [])
    const ctx = resolveTerminalContext(plan, true)
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
    const ctx = resolveTerminalContext(plan, false, projectsDir)
    expect(ctx.claudeSessionId).not.toBeNull()
    expect(ctx.inject).toContain('branched after its turn 1')
    expect(ctx.inject).not.toContain('── Turn 1 ──')
  })
})
