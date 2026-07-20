// Team snapshots and the team-fork engine (spec note: team-fork-roles v1).
//
// TEAM SAVE: the live canvas (nodes, connections, layout) plus every
// terminal's turn history is snapshotted to ~/.cookrew/teams/<slug>.json.
//
// TEAM FORK: builds a NEW workspace from selected nodes of the live canvas
// (or a saved snapshot), with a per-terminal turn strategy — latest/first
// (native Claude session truncation when possible, else preamble replay),
// assembled (hand-picked turns replayed as preamble) or role (fresh boot
// from a saved role). Notes/browsers are copied, connections and layout are
// preserved, and every node gets a fresh id.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  AgentRole,
  CanvasNode,
  Connection,
  GitInfo,
  TeamForkChoice,
  TeamForkSpec,
  TeamMeta,
  TerminalNodeData,
  WorkspaceMeta,
  WorkspaceState
} from '../shared/model'
import { normalizeDirs } from '../shared/model'
import type { TurnRecord } from '../shared/turn'
import {
  buildAssembledPreamble,
  buildForkPreamble,
  buildResumeForkNotice,
  buildRoleBootMessage
} from '../shared/fork'
import { stripSessionFlags } from '../shared/claude-fork'
import { forkClaudeSession } from './claude-fork'
import { injectWhenReady } from './fork'
import { roleSlug } from './roles'
import type { RoleStore } from './roles'
import type { WorkspaceStore } from './store'
import type { PtyManager } from './pty'
import type { TurnTracker } from './turn-tracker'

// ---- team snapshots (~/.cookrew/teams) ----

export interface TeamSnapshot {
  name: string
  savedAt: number
  dir: string
  /** Working directories captured at save time (primary first). */
  dirs?: string[]
  nodes: CanvasNode[]
  connections: Connection[]
  /** Turn histories captured at save time, keyed by ORIGINAL terminal id. */
  turns: Record<string, TurnRecord[]>
}

function isSnapshot(value: unknown): value is TeamSnapshot {
  const s = value as TeamSnapshot
  return (
    typeof s === 'object' &&
    s !== null &&
    typeof s.name === 'string' &&
    typeof s.savedAt === 'number' &&
    Array.isArray(s.nodes) &&
    Array.isArray(s.connections) &&
    typeof s.turns === 'object'
  )
}

function metaOf(snapshot: TeamSnapshot): TeamMeta {
  return {
    name: snapshot.name,
    savedAt: snapshot.savedAt,
    nodeCount: snapshot.nodes.length,
    terminalCount: snapshot.nodes.filter((n) => n.kind === 'terminal').length
  }
}

export class TeamStore {
  constructor(private dir = path.join(homedir(), '.cookrew', 'teams')) {}

  private fileFor(name: string): string {
    return path.join(this.dir, `${roleSlug(name)}.json`)
  }

  /** Snapshot the given canvas under a name. Same name overwrites. */
  save(state: WorkspaceState, turnsOf: (terminalId: string) => TurnRecord[], name?: string): TeamMeta {
    const teamName = (name ?? state.name).trim()
    if (teamName.length === 0) throw new Error('Team name must not be empty')
    const snapshot: TeamSnapshot = {
      name: teamName,
      savedAt: Date.now(),
      dir: state.dir,
      dirs: state.dirs,
      nodes: state.nodes,
      connections: state.connections,
      turns: Object.fromEntries(
        state.nodes.filter((n) => n.kind === 'terminal').map((t) => [t.id, turnsOf(t.id)])
      )
    }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.fileFor(teamName), JSON.stringify(snapshot, null, 2), 'utf8')
    return metaOf(snapshot)
  }

  list(): TeamMeta[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.read(path.join(this.dir, f)))
      .filter((s): s is TeamSnapshot => s !== null)
      .map(metaOf)
      .sort((a, b) => b.savedAt - a.savedAt)
  }

  /** Case-insensitive lookup by team name. */
  load(name: string): TeamSnapshot | undefined {
    const direct = this.read(this.fileFor(name))
    if (direct) return direct
    if (!existsSync(this.dir)) return undefined
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      const snap = this.read(path.join(this.dir, f))
      if (snap && snap.name.toLowerCase() === name.trim().toLowerCase()) return snap
    }
    return undefined
  }

  private read(file: string): TeamSnapshot | null {
    try {
      if (!existsSync(file)) return null
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return isSnapshot(parsed) ? parsed : null
    } catch (error) {
      console.error('Failed to read team snapshot:', error)
      return null
    }
  }
}

// ---- fork planning (pure — unit tested without fs/store) ----

/** What a team fork reads from: the live canvas or a saved snapshot. */
export interface TeamForkSource {
  name: string
  dir: string
  /** Working directories of the source workspace, primary first. */
  dirs: string[]
  nodes: CanvasNode[]
  connections: Connection[]
  turnsOf: (terminalId: string) => TurnRecord[]
  /** Saved snapshots can't be natively session-forked — preamble only. */
  fromSnapshot: boolean
}

export interface TerminalForkPlan {
  newId: string
  source: TerminalNodeData
  mode: TeamForkChoice['mode']
  /** Fork point for latest/first; null when the source has no turns yet. */
  turnIndex: number | null
  turns: TurnRecord[]
  turnIndexes: number[]
  role: AgentRole | null
  /** Directory the forked terminal starts in (may be repointed to a worktree). */
  targetDir: string
}

export interface TeamForkPlan {
  name: string
  /** Directory set for the forked workspace. */
  dirs: string[]
  nodes: CanvasNode[]
  connections: Connection[]
  terminals: TerminalForkPlan[]
}

interface PlanDeps {
  newId: () => string
  roleOf: (name: string) => AgentRole | undefined
}

/**
 * Resolve which workspace dir a forked terminal lands in: the explicit
 * choice when it's a valid target, else the source cwd if still present,
 * else the primary.
 */
function resolveTargetDir(
  sourceCwd: string,
  choiceDir: string | undefined,
  dirs: string[]
): string {
  if (choiceDir && dirs.includes(choiceDir)) return choiceDir
  if (dirs.includes(sourceCwd)) return sourceCwd
  return dirs[0]
}

function planTerminal(
  node: TerminalNodeData,
  newId: string,
  choice: TeamForkChoice | undefined,
  history: TurnRecord[],
  dirs: string[],
  deps: PlanDeps
): { forked: TerminalNodeData; plan: TerminalForkPlan } {
  const mode = choice?.mode ?? 'latest'
  const targetDir = resolveTargetDir(node.cwd, choice?.targetDir, dirs)

  let role: AgentRole | null = null
  if (mode === 'role') {
    role = deps.roleOf(choice?.roleName ?? '') ?? null
    if (!role) {
      throw new Error(`No saved role '${choice?.roleName ?? ''}' to fork agent '${node.name}' from`)
    }
  }

  const turnIndexes = choice?.turnIndexes ?? []
  if (mode === 'assembled' && !turnIndexes.some((i) => history.some((t) => t.index === i))) {
    throw new Error(`Agent '${node.name}' has none of the selected turns to assemble from`)
  }

  const turnIndex =
    mode === 'latest'
      ? (history[history.length - 1]?.index ?? null)
      : mode === 'first'
        ? (history[0]?.index ?? null)
        : mode === 'assembled'
          ? (turnIndexes[turnIndexes.length - 1] ?? null)
          : null

  const forked: TerminalNodeData = {
    ...node,
    id: newId,
    cwd: targetDir,
    preset: role ? role.preset : node.preset,
    // Session binding never carries over — the fork engine assigns its own.
    command: stripSessionFlags(role ? role.command : node.command),
    claudeSessionId: null,
    role: role ? role.name : node.role,
    forkOf:
      mode === 'role' || turnIndex === null
        ? null
        : { sourceId: node.id, sourceName: node.name, turnIndex }
  }
  return {
    forked,
    plan: { newId, source: node, mode, turnIndex, turns: history, turnIndexes, role, targetDir }
  }
}

/**
 * Pure planning step: which nodes the forked workspace contains (fresh ids,
 * remapped connections, layout preserved) and what each terminal forks from.
 */
export function planTeamFork(
  source: TeamForkSource,
  spec: TeamForkSpec,
  deps: PlanDeps
): TeamForkPlan {
  const included = new Set(spec.nodeIds)
  const choiceFor = new Map(spec.choices.map((c) => [c.nodeId, c]))
  const idMap = new Map<string, string>()
  const nodes: CanvasNode[] = []
  const terminals: TerminalForkPlan[] = []
  const dirs = normalizeDirs({ dirs: spec.dirs ?? source.dirs })
  const finalDirs = dirs.length > 0 ? dirs : [source.dir]

  for (const node of source.nodes) {
    if (!included.has(node.id)) continue
    const newId = deps.newId()
    idMap.set(node.id, newId)
    if (node.kind !== 'terminal') {
      nodes.push({ ...node, id: newId })
      continue
    }
    const { forked, plan } = planTerminal(
      node,
      newId,
      choiceFor.get(node.id),
      source.turnsOf(node.id),
      finalDirs,
      deps
    )
    nodes.push(forked)
    terminals.push(plan)
  }
  if (nodes.length === 0) throw new Error('Team fork needs at least one selected node')

  const connections = source.connections
    .filter((c) => idMap.has(c.a) && idMap.has(c.b))
    .map((c) => ({
      id: deps.newId(),
      a: idMap.get(c.a) as string,
      b: idMap.get(c.b) as string
    }))

  return {
    name: spec.name?.trim() || `${source.name} fork`,
    dirs: finalDirs,
    nodes,
    connections,
    terminals
  }
}

/**
 * The context a forked terminal boots with: a native Claude session copy
 * (claudeSessionId + short notice) when possible, else a preamble/role
 * message to inject — or nothing for a source with no history.
 */
export function resolveTerminalContext(
  plan: TerminalForkPlan,
  fromSnapshot: boolean,
  projectsDir?: string
): { inject: string | null; claudeSessionId: string | null } {
  const forkName = plan.source.name
  if (plan.mode === 'role' && plan.role) {
    return {
      inject: buildRoleBootMessage(plan.role.name, plan.role.rolePrompt),
      claudeSessionId: null
    }
  }
  if (plan.mode === 'assembled') {
    return {
      inject: buildAssembledPreamble({
        forkName,
        sourceName: plan.source.name,
        turns: plan.turns,
        turnIndexes: plan.turnIndexes
      }),
      claudeSessionId: null
    }
  }
  if (plan.turnIndex === null) return { inject: null, claudeSessionId: null }
  if (!fromSnapshot) {
    const native = forkClaudeSession({
      command: plan.source.command,
      cwd: plan.source.cwd,
      sessionId: plan.source.claudeSessionId,
      turns: plan.turns,
      turnIndex: plan.turnIndex,
      projectsDir
    })
    if (native) {
      return {
        inject: buildResumeForkNotice({
          forkName,
          sourceName: plan.source.name,
          turnIndex: plan.turnIndex
        }),
        claudeSessionId: native.sessionId
      }
    }
  }
  return {
    inject: buildForkPreamble({
      forkName,
      sourceName: plan.source.name,
      turns: plan.turns,
      turnIndex: plan.turnIndex
    }),
    claudeSessionId: null
  }
}

// ---- worktree resolution (GOAL 5) ----

/** A repo directory a fork will get its own `git worktree add` copy of. */
export interface WorktreeCandidate {
  repoDir: string
  worktreePath: string
  branch: string
}

/**
 * Pure: which of a fork's dirs become worktrees, and where. A dir is a
 * candidate when worktrees are enabled and it's a git repo; each maps to a
 * path under `worktreeRoot` named by its basename. The actual `git worktree
 * add` (and its fallback) happens in the async executor.
 */
export function planWorktrees(
  dirs: string[],
  isRepo: (dir: string) => boolean,
  opts: { enabled: boolean; worktreeRoot: string; branch: string }
): WorktreeCandidate[] {
  if (!opts.enabled) return []
  return dirs
    .filter((dir) => isRepo(dir))
    .map((repoDir) => ({
      repoDir,
      worktreePath: path.join(opts.worktreeRoot, path.basename(repoDir) || 'repo'),
      branch: opts.branch
    }))
}

export interface WorktreeApi {
  gitInfo: (dir: string) => Promise<GitInfo>
  addWorktree: (
    repoDir: string,
    worktreePath: string,
    branch: string
  ) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
}

/**
 * Execute worktree creation for a plan's dirs. Returns a remap from original
 * repo dir → worktree path for every SUCCESSFUL add; failures are omitted
 * (fork-in-place fallback) and their errors collected. Never throws.
 */
export async function resolveWorktrees(
  api: WorktreeApi,
  dirs: string[],
  opts: { enabled: boolean; worktreeRoot: string; branch: string }
): Promise<{ remap: Map<string, string>; errors: string[] }> {
  const remap = new Map<string, string>()
  const errors: string[] = []
  if (!opts.enabled) return { remap, errors }

  const repoFlags = await Promise.all(
    dirs.map((dir) => api.gitInfo(dir).then((g) => g.isRepo).catch(() => false))
  )
  const candidates = planWorktrees(dirs, (dir) => repoFlags[dirs.indexOf(dir)], opts)
  for (const c of candidates) {
    const result = await api.addWorktree(c.repoDir, c.worktreePath, c.branch)
    if (result.ok) remap.set(c.repoDir, result.path)
    else errors.push(`${c.repoDir}: ${result.error}`)
  }
  return { remap, errors }
}

/** Apply a repo-dir → worktree-path remap to dirs and terminal cwds. */
export function applyWorktreeRemap(plan: TeamForkPlan, remap: Map<string, string>): TeamForkPlan {
  if (remap.size === 0) return plan
  const dirs = plan.dirs.map((d) => remap.get(d) ?? d)
  const nodes = plan.nodes.map((n) =>
    n.kind === 'terminal' && remap.has(n.cwd) ? { ...n, cwd: remap.get(n.cwd) as string } : n
  )
  const terminals = plan.terminals.map((t) => ({
    ...t,
    targetDir: remap.get(t.targetDir) ?? t.targetDir
  }))
  return { ...plan, dirs, nodes, terminals }
}

// ---- orchestrator ----

export interface TeamForkDeps {
  store: WorkspaceStore
  turns: TurnTracker
  roles: RoleStore
  teams: TeamStore
  ptys: PtyManager
  /** index.ts switch wrapper — the switch boots the forked terminals. */
  switchWorkspace: (id: string) => void
  /** Git worktree operations (injectable for tests). */
  git: WorktreeApi
  /** Root under which fork worktrees are created (default ~/.cookrew/worktrees). */
  worktreeRoot: string
  /** Test override for ~/.claude/projects (native session forks). */
  projectsDir?: string
}

function resolveSource(deps: TeamForkDeps, spec: TeamForkSpec): TeamForkSource {
  if (spec.fromSavedTeam) {
    const snap = deps.teams.load(spec.fromSavedTeam)
    if (!snap) throw new Error(`No saved team '${spec.fromSavedTeam}'`)
    return {
      name: snap.name,
      dir: snap.dir,
      dirs: normalizeDirs({ dir: snap.dir, dirs: snap.dirs }),
      nodes: snap.nodes,
      connections: snap.connections,
      turnsOf: (id) => snap.turns[id] ?? [],
      fromSnapshot: true
    }
  }
  const state = deps.store.state
  return {
    name: state.name,
    dir: state.dir,
    dirs: state.dirs,
    nodes: state.nodes,
    connections: state.connections,
    turnsOf: (id) => deps.turns.history(id),
    fromSnapshot: false
  }
}

/**
 * Execute a team fork: plan, write native session copies, create the new
 * workspace pre-seeded with the forked nodes, switch to it (which boots the
 * terminals), then inject each terminal's context once its TUI is quiet.
 */
export async function forkTeam(deps: TeamForkDeps, spec: TeamForkSpec): Promise<WorkspaceMeta> {
  const source = resolveSource(deps, spec)
  const planned = planTeamFork(source, spec, {
    newId: randomUUID,
    roleOf: (name) => deps.roles.get(name)
  })

  // GOAL 5: repo dirs get their own worktree (default on); failures fall
  // back to in-place and are logged, never aborting the fork.
  const branch = `cookrew/${roleSlug(planned.name)}`
  const worktreeRoot = path.join(deps.worktreeRoot, `${roleSlug(planned.name)}-${randomUUID().slice(0, 8)}`)
  const { remap, errors } = await resolveWorktrees(deps.git, planned.dirs, {
    enabled: spec.worktree !== false,
    worktreeRoot,
    branch
  })
  for (const error of errors) console.error('Team fork worktree fell back to in-place:', error)
  const plan = applyWorktreeRemap(planned, remap)

  const contexts = new Map(
    plan.terminals.map((t) => [
      t.newId,
      resolveTerminalContext(t, source.fromSnapshot, deps.projectsDir)
    ])
  )
  const nodes = plan.nodes.map((n) => {
    const context = contexts.get(n.id)
    return context && n.kind === 'terminal'
      ? { ...n, claudeSessionId: context.claudeSessionId }
      : n
  })

  const meta = deps.store.createWorkspaceWithState(
    plan.name,
    plan.dirs[0],
    nodes,
    plan.connections,
    undefined,
    plan.dirs
  )
  deps.switchWorkspace(meta.id)

  for (const t of plan.terminals) {
    const inject = contexts.get(t.newId)?.inject
    if (!inject) continue
    const session = deps.ptys.get(t.newId)
    if (session) {
      injectWhenReady(session, inject).catch((error) => {
        console.error('Team fork context injection failed:', error)
      })
    }
  }
  return meta
}
