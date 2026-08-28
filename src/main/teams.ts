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
import {
  constants as fsConstants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type {
  AgentRole,
  CanvasNode,
  Connection,
  GitInfo,
  TeamCopyResult,
  TeamCopySpec,
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
  buildAssembledForkNotice,
  buildAssembledPreamble,
  buildForkPreamble,
  buildResumeForkNotice,
  buildRoleBootMessage
} from '../shared/fork'
import { stripSessionFlags } from '../shared/claude-fork'
import { scopeToSelection } from '../shared/team-actions'
import { fileSlug } from '../shared/slug'
import { claudeSessionFile, forkClaudeSession, forkClaudeSessionAssembled } from './claude-fork'
import { injectWhenReady } from './fork'
import { isPiCommand, stripPiSessionFlags } from './pi-bind'
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
  /**
   * Claude session files snapshotted at save time (checkpoint-program-spec
   * item 2b): ORIGINAL terminal id → sidecar file name under
   * ~/.cookrew/teams/<slug>-sessions/. Lets fork-from-saved native-rewind in
   * a fresh project dir instead of falling back to preamble replay.
   */
  sessions?: Record<string, string>
  /**
   * The ENTRY agent — the orchestrator a caller talks to. A template is a
   * preset with one door: importing it as a service creates a session and a
   * single terminal for THIS agent, which runs the rest of the team. Stored by
   * node name (stable across the fork's fresh ids). Absent on templates saved
   * before this field: readers fall back to entryAgentOf().
   */
  entryAgent?: string
}

/**
 * The orchestrator to enter a template through. The node flagged `orch`, or —
 * for a template saved without one, or an older snapshot — the first terminal
 * in canvas order. Never null when the snapshot has a terminal, because a
 * template you cannot enter is a template you cannot use.
 */
export function entryAgentOf(snapshot: TeamSnapshot): string | null {
  const terminals = snapshot.nodes.filter(
    (n): n is Extract<CanvasNode, { kind: 'terminal' }> => n.kind === 'terminal'
  )
  if (terminals.length === 0) return null
  if (snapshot.entryAgent) {
    const named = terminals.find((t) => t.name === snapshot.entryAgent)
    if (named) return named.name
  }
  const orch = terminals.find((t) => t.orch)
  return (orch ?? terminals[0]).name
}

/**
 * The door of a SERVED crew — the orch, or nothing.
 *
 * Deliberately not `entryAgentOf`. That one answers "which agent do I enter
 * this template through" for a LOCAL import, where falling back to the first
 * terminal is a kindness to the owner opening their own crew. Serving asks the
 * same-shaped question with a stranger on the other end, and the owner ruled
 * (2026-08-26) that a crew without an orch must be refused rather than
 * answered: `QA Shell Door` — one terminal, no orch, empty command — served
 * happily and "replied" by running the caller's prompt at a zsh prompt.
 *
 * `entryAgent` MAY NOT PROMOTE. It looks like an explicit designation, but
 * `TeamStore.save` computes it as orch-else-first-terminal, so honouring it
 * here would restore the fallback by another route — every orch-less team on
 * disk has it set. It breaks a tie between orchs and does nothing else.
 */
export function orchAgentOf(snapshot: TeamSnapshot): string | null {
  const orchs = snapshot.nodes.filter(
    (n): n is Extract<CanvasNode, { kind: 'terminal' }> => n.kind === 'terminal' && n.orch === true
  )
  if (orchs.length === 0) return null
  const named = snapshot.entryAgent
    ? orchs.find((t) => t.name === snapshot.entryAgent)
    : undefined
  return (named ?? orchs[0]).name
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
    terminalCount: snapshot.nodes.filter((n) => n.kind === 'terminal').length,
    // Mini-graph for template pickers: the same cable-relation thumbnail
    // the clipboard tray shows, so a saved team reads at a glance.
    preview: {
      items: snapshot.nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        name: n.name,
        position: n.position,
        size: n.size
      })),
      cables: snapshot.connections.map((c) => ({ a: c.a, b: c.b }))
    }
  }
}

export class TeamStore {
  constructor(
    private dir = path.join(homedir(), '.cookrew', 'teams'),
    /** Override for tests; defaults to ~/.claude/projects. */
    private projectsDir?: string
  ) {}

  private fileFor(name: string): string {
    return path.join(this.dir, `${roleSlug(name)}.json`)
  }

  private sessionsDirFor(name: string): string {
    return path.join(this.dir, `${roleSlug(name)}-sessions`)
  }

  /**
   * Snapshot the given canvas under a name. Same name overwrites. Claude
   * terminals with a live session file get that file COPIED into the team's
   * sessions sidecar, so a later fork-from-saved can native-rewind even in a
   * fresh directory (item 2b) — the canvas may be long gone by then.
   *
   * With nodeIds the snapshot is SCOPED to that selection (Figma model):
   * only the selected nodes, only the cables with both ends selected, only
   * those terminals' turns and sessions.
   */
  save(
    fullState: WorkspaceState,
    turnsOf: (terminalId: string) => TurnRecord[],
    name?: string,
    nodeIds?: string[]
  ): TeamMeta {
    const state =
      nodeIds && nodeIds.length > 0 ? scopeToSelection(fullState, nodeIds) : fullState
    if (state.nodes.length === 0) {
      throw new Error('Team save needs at least one node — the selection matched nothing')
    }
    const teamName = (name ?? state.name).trim()
    if (teamName.length === 0) throw new Error('Team name must not be empty')
    const sessions = this.snapshotSessions(teamName, state)
    // The entry orchestrator, captured at save so the template records its own
    // door: the orch-flagged terminal, else the first. A caller imports through
    // this one agent.
    const entryTerminal =
      state.nodes.find((n) => n.kind === 'terminal' && n.orch) ??
      state.nodes.find((n) => n.kind === 'terminal')
    const snapshot: TeamSnapshot = {
      name: teamName,
      savedAt: Date.now(),
      dir: state.dir,
      dirs: state.dirs,
      nodes: state.nodes,
      connections: state.connections,
      turns: Object.fromEntries(
        state.nodes.filter((n) => n.kind === 'terminal').map((t) => [t.id, turnsOf(t.id)])
      ),
      ...(Object.keys(sessions).length > 0 ? { sessions } : {}),
      ...(entryTerminal ? { entryAgent: entryTerminal.name } : {})
    }
    mkdirSync(this.dir, { recursive: true })
    writeFileSync(this.fileFor(teamName), JSON.stringify(snapshot, null, 2), 'utf8')
    this.pruneSessionSidecars(teamName, new Set(Object.values(sessions)))
    return metaOf(snapshot)
  }

  private snapshotSessions(teamName: string, state: WorkspaceState): Record<string, string> {
    const sessions: Record<string, string> = {}
    const sidecar = this.sessionsDirFor(teamName)
    for (const node of state.nodes) {
      if (node.kind !== 'terminal' || !node.claudeSessionId) continue
      try {
        const source = claudeSessionFile(node.cwd, node.claudeSessionId, this.projectsDir)
        if (!existsSync(source)) continue
        mkdirSync(sidecar, { recursive: true })
        const fileName = `${node.id}.jsonl`
        // APFS clones share unchanged blocks with the source while remaining a
        // real immutable snapshot. Other filesystems transparently fall back.
        copyFileSync(source, path.join(sidecar, fileName), fsConstants.COPYFILE_FICLONE)
        sessions[node.id] = fileName
      } catch (error) {
        console.error('Team save session snapshot failed (preamble fallback):', error)
      }
    }
    return sessions
  }

  /** Remove stale files only AFTER the new snapshot JSON commits successfully. */
  private pruneSessionSidecars(teamName: string, keep: ReadonlySet<string>): void {
    const sidecar = this.sessionsDirFor(teamName)
    if (!existsSync(sidecar)) return
    if (keep.size === 0) {
      rmSync(sidecar, { recursive: true, force: true })
      return
    }
    for (const entry of readdirSync(sidecar, { withFileTypes: true })) {
      if (!entry.isFile() || keep.has(entry.name)) continue
      rmSync(path.join(sidecar, entry.name), { force: true })
    }
  }

  /** Snapshot session lines for a saved team's terminal, or null. */
  sessionLines(snapshot: TeamSnapshot, terminalId: string): string[] | null {
    const fileName = snapshot.sessions?.[terminalId]
    if (!fileName) return null
    try {
      const file = path.join(this.sessionsDirFor(snapshot.name), fileName)
      return existsSync(file) ? readFileSync(file, 'utf8').split('\n') : null
    } catch (error) {
      console.error('Team session snapshot read failed:', error)
      return null
    }
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

  /**
   * Bring older templates onto the new logic: any snapshot saved before the
   * entry-orchestrator field gets one stamped in place, computed the same way
   * a fresh save would (orch node, else first terminal). Non-destructive —
   * rewriting the field, never the team — so a saved crew is upgraded, not
   * lost. Returns how many were migrated, for the boot log.
   */
  migrateEntryAgents(): number {
    if (!existsSync(this.dir)) return 0
    let migrated = 0
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith('.json'))) {
      const file = path.join(this.dir, f)
      const snap = this.read(file)
      if (!snap || snap.entryAgent) continue
      const entry = entryAgentOf(snap)
      if (!entry) continue
      writeFileSync(file, JSON.stringify({ ...snap, entryAgent: entry }, null, 2), 'utf8')
      migrated++
    }
    return migrated
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
  fromSnapshot: boolean
  /**
   * Snapshot session lines for a terminal (saved teams with session
   * sidecars). Null → live-disk resolution (fromSnapshot false) or preamble
   * fallback (fromSnapshot true, pre-sidecar snapshots / Codex agents).
   */
  sessionLinesOf?: (terminalId: string) => string[] | null
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
  /** Node ids that keep their ORIGINAL id (cut-paste identity transfer). */
  keepIdentity?: ReadonlySet<string>
  /**
   * Terminal ids whose SESSION moves to the copy (cut-paste). They still
   * re-id; only the conversation travels. See TeamCopySpec.carrySessions.
   */
  carrySessions?: ReadonlySet<string>
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

  // A CUT MOVES the conversation: the source card is removed, so nothing is
  // left to append to that session and the copy may hold its ref outright.
  // Same ref means no lineage transition, no spurious /clear marker on the
  // rail, and checkpoint ordinals identical either side of the paste — the
  // rule session-move.ts already follows for a workdir change. A role fork
  // is a different agent by definition, so it never carries.
  const carries = mode !== 'role' && deps.carrySessions?.has(node.id) === true

  const forked: TerminalNodeData = {
    ...node,
    id: newId,
    cwd: targetDir,
    preset: role ? role.preset : node.preset,
    // NO session binding carries over — the fork engine assigns its own.
    // An inherited codexSessionRef/opencodeSessionId would make the copy
    // `resume` the SOURCE's live session file: duplicate-in-place would run
    // two processes appending to one rollout. Lineage and the restore stack
    // reference the source's sessions, so they stay behind too.
    command: isPiCommand(role ? role.command : node.command)
      ? stripPiSessionFlags(role ? role.command : node.command)
      : stripSessionFlags(role ? role.command : node.command),
    claudeSessionId: carries ? (node.claudeSessionId ?? null) : null,
    piSessionId: carries ? (node.piSessionId ?? null) : null,
    codexSessionRef: carries ? (node.codexSessionRef ?? null) : null,
    opencodeSessionId: carries ? (node.opencodeSessionId ?? null) : null,
    // Lineage travels with the session it describes: it names the earlier
    // segments of THIS conversation, which is now this card's.
    sessionLineage: carries ? node.sessionLineage : undefined,
    // The restore stack is not carried even by a move: its entries reference
    // the source terminal's snapshots by its id, which is gone.
    restoreStack: undefined,
    pendingInject: null,
    role: role ? role.name : node.role,
    forkOf:
      carries || mode === 'role' || turnIndex === null
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
  // Saved-team semantics (BUG 1, note workspace-from-template-role): the
  // picker sends nodeIds: [] for a snapshot source to mean "the whole saved
  // team" — snapshot node ids aren't known to the live canvas, so per-node
  // selection only applies to live forks. An empty LIVE selection stays an
  // error (below).
  const includeAll = source.fromSnapshot && spec.nodeIds.length === 0
  const included = new Set(includeAll ? source.nodes.map((n) => n.id) : spec.nodeIds)
  const choiceFor = new Map(spec.choices.map((c) => [c.nodeId, c]))
  const idMap = new Map<string, string>()
  const nodes: CanvasNode[] = []
  const terminals: TerminalForkPlan[] = []
  const dirs = normalizeDirs({ dirs: spec.dirs ?? source.dirs })
  const finalDirs = dirs.length > 0 ? dirs : [source.dir]

  for (const node of source.nodes) {
    if (!included.has(node.id)) continue
    const newId = deps.keepIdentity?.has(node.id) ? node.id : deps.newId()
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
  if (nodes.length === 0) {
    // Echo the received spec shape — this rejection has historically hidden
    // payload mismatches (stale live ids against a snapshot, empty include
    // sets), and the shape makes the next repro immediate.
    const idsPreview = spec.nodeIds.slice(0, 5).map((id) => `"${id}"`).join(', ')
    const truncated = spec.nodeIds.length > 5 ? `, … +${spec.nodeIds.length - 5}` : ''
    throw new Error(
      'Team fork needs at least one selected node — ' +
        `received nodeIds=[${idsPreview}${truncated}] (${spec.nodeIds.length}), ` +
        `choices=${spec.choices.length}, ` +
        `fromSavedTeam=${spec.fromSavedTeam ? `"${spec.fromSavedTeam}"` : 'none'}; ` +
        `source has ${source.nodes.length} node${source.nodes.length === 1 ? '' : 's'}`
    )
  }

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
export interface TerminalContextSource {
  fromSnapshot: boolean
  /** Snapshot session lines for a terminal (saved-team sidecars), if any. */
  sessionLinesOf?: (terminalId: string) => string[] | null
}

export function resolveTerminalContext(
  plan: TerminalForkPlan,
  source: TerminalContextSource,
  projectsDir?: string
): { inject: string | null; claudeSessionId: string | null } {
  const forkName = plan.source.name
  if (plan.mode === 'role' && plan.role) {
    return {
      inject: buildRoleBootMessage(plan.role.name, plan.role.rolePrompt),
      claudeSessionId: null
    }
  }
  // Snapshot sidecar lines (saved teams) let both native paths run without
  // the live ~/.claude files; live forks read the disk as before.
  const snapshotLines = source.sessionLinesOf?.(plan.source.id) ?? null
  const nativeEligible = !source.fromSnapshot || snapshotLines !== null
  if (plan.mode === 'assembled') {
    // Item 2a: native assembly — the fork's session contains exactly the
    // selected checkpoints' uuid ranges. Preamble stays the Codex/legacy
    // fallback (no session file or uuid-less records).
    if (nativeEligible) {
      const native = forkClaudeSessionAssembled({
        command: plan.source.command,
        cwd: plan.source.cwd,
        sessionId: plan.source.claudeSessionId,
        turns: plan.turns,
        turnIndexes: plan.turnIndexes,
        targetCwd: plan.targetDir,
        sourceLines: snapshotLines ?? undefined,
        projectsDir
      })
      if (native) {
        return {
          inject: buildAssembledForkNotice({
            forkName,
            sourceName: plan.source.name,
            turnIndexes: [...plan.turnIndexes].sort((a, b) => a - b)
          }),
          claudeSessionId: native.sessionId
        }
      }
    }
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
  if (nativeEligible) {
    const native = forkClaudeSession({
      command: plan.source.command,
      cwd: plan.source.cwd,
      sessionId: plan.source.claudeSessionId,
      turns: plan.turns,
      turnIndex: plan.turnIndex,
      targetCwd: plan.targetDir,
      sourceLines: snapshotLines ?? undefined,
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
  /**
   * Bring a freshly forked workspace's terminals ALIVE, without focusing it.
   *
   * BOOT AND FOCUS WERE ONE ACT, and only because nothing had ever needed them
   * apart. `switchWorkspace` was called at the end of a fork for its side
   * effect — the switch is what boots the terminals — which is correct for the
   * owner forking on their own canvas and wrong for anything created on their
   * behalf: a SERVED session would yank the owner's screen to a stranger's
   * workspace on that stranger's first call, once per caller, forever.
   *
   * The codebase already knew these were different. copyTeam's own note says
   * "the view does NOT switch: nodes come alive now only when the target is the
   * live canvas; otherwise terminals boot on activation" — a deferred boot that
   * a served session can never reach, because it is never activated.
   *
   * So the fork asks for BOOT and the caller decides whether that includes
   * focus. The owner's path passes a switching implementation and is
   * byte-unchanged; a served session passes one that boots in place.
   */
  bootTerminals?: (id: string) => void
  /**
   * Bring one just-added node alive on the ACTIVE canvas — the same per-kind
   * side effects index.ts addNode owns (spawn terminals, sync browsers).
   * copyTeam uses it when the copy lands on the live workspace; copies into
   * inactive workspaces come alive on activation — same rule as agent-recover.
   */
  adoptNode?: (n: CanvasNode) => void
  /**
   * Is this terminal mid-turn right now? A WORKING agent cannot be copied —
   * its session file is being appended to and a clone taken mid-write is
   * neither the turn's before nor its after. Absent → nothing is working.
   */
  isWorking?: (terminalId: string) => boolean
  /**
   * Move a CUT terminal's conversation onto its new card: the turn ledger
   * (keyed by terminal id, so a re-id would otherwise open a blank
   * transcript) and, for a harness whose sessions are keyed by directory,
   * the session file itself. Absent → nothing carries, and spec.carrySessions
   * is inert; present → called once per carried terminal before the boot.
   */
  carrySession?: (from: TerminalNodeData, to: TerminalNodeData) => void
  /** Git worktree operations (injectable for tests). */
  git: WorktreeApi
  /** Root under which fork worktrees are created (default ~/.cookrew/worktrees). */
  worktreeRoot: string
  /** Test override for ~/.claude/projects (native session forks). */
  projectsDir?: string
}

/**
 * Fork source for a NON-active workspace (PASTE after a switch): state from
 * the store, turn histories from the tracker (keyed by terminal id, so they
 * survive the detach), live-disk session resolution — the same recover-mode
 * machinery that re-binds an agent's session in a new directory.
 */
function sourceFromWorkspace(deps: TeamForkDeps, workspaceId: string): TeamForkSource {
  const state = deps.store.workspaceState(workspaceId)
  return {
    name: state.name,
    dir: state.dir,
    dirs: normalizeDirs({ dir: state.dir, dirs: state.dirs }),
    nodes: state.nodes,
    connections: state.connections,
    turnsOf: (id) => deps.turns.history(id),
    fromSnapshot: false
  }
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
      fromSnapshot: true,
      sessionLinesOf: (id) => deps.teams.sessionLines(snap, id)
    }
  }
  // The live canvas a fork is taken from: the workspace the caller named, or
  // the focused one for a seat that did not name one. Reading focus
  // unconditionally would pair the CLI's caller-scoped nodeIds with a
  // different workspace's nodes and fork the wrong canvas.
  const state = spec.fromWorkspaceId
    ? deps.store.workspaceState(spec.fromWorkspaceId)
    : deps.store.focusedState
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
/**
 * FEATURE 1 (note workspace-from-template-role): create a workspace from a
 * saved team TEMPLATE — the fromSavedTeam fork machinery over the whole
 * snapshot, retargeted to one directory. Session sidecars native-restore in
 * the fresh project dir; worktrees stay off — the target dir IS the
 * requested workspace location, not a scratch copy.
 */
export async function workspaceFromTemplate(
  deps: TeamForkDeps,
  input: { name: string; dir: string; team: string }
): Promise<WorkspaceMeta> {
  if (!deps.teams.load(input.team)) {
    throw new Error(`No saved team '${input.team}' to use as a template`)
  }
  const dir = input.dir.trim()
  return forkTeam(deps, {
    name: input.name,
    nodeIds: [], // snapshot semantic: the whole saved team
    choices: [],
    fromSavedTeam: input.team,
    dirs: dir.length > 0 ? [dir] : undefined,
    worktree: false
  })
}

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
      resolveTerminalContext(t, source, deps.projectsDir)
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
  // Default is the switch, so every existing caller — `cookrew workspace create
  // --team` included — behaves exactly as before.
  ;(deps.bootTerminals ?? deps.switchWorkspace)(meta.id)

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

// ---- copy a selection into an EXISTING workspace (Figma model) ----

/** Offset so a copy never lands pixel-exact on its source (Figma paste). */
const COPY_NUDGE_PX = 32

/**
 * Copy selected canvas elements into an existing workspace: same planning
 * as a fork (fresh ids, remapped cables, latest checkpoints, native session
 * copies) but the nodes are APPENDED to the target instead of seeding a new
 * workspace. Copies adopt the TARGET's working directories — a source cwd
 * survives only if the target already lists it, else the terminal lands in
 * the target's primary dir, with its context riding the same
 * session-restore machinery agent-recover uses. WORKING agents refuse to be
 * copied (isWorking). The view does NOT switch: nodes come alive now only
 * when the target is the live canvas; otherwise terminals boot on
 * activation, which also delivers any stashed context preamble
 * (pendingInject) that could not be injected into an unbooted PTY.
 */
export async function copyTeam(deps: TeamForkDeps, spec: TeamCopySpec): Promise<TeamCopyResult> {
  // The IPC layer's type annotations are compile-time fiction; validate here
  // so both entry points (IPC + mobile HTTP) share one guard.
  if (!Array.isArray(spec.nodeIds) || !spec.nodeIds.every((id) => typeof id === 'string')) {
    throw new Error('Team copy needs nodeIds as a string[]')
  }
  if (typeof spec.intoWorkspaceId !== 'string') {
    throw new Error('Team copy needs intoWorkspaceId as a string')
  }
  const workspaces = deps.store.list().workspaces
  const target = workspaces.find((w) => w.id === spec.intoWorkspaceId)
  if (!target) throw new Error(`No workspace '${spec.intoWorkspaceId}' to copy into`)
  const intoActive = target.id === deps.store.focusedId
  if (intoActive && !deps.adoptNode) {
    throw new Error('Team copy onto the live canvas requires the adoptNode dep')
  }

  const fromId = spec.fromWorkspaceId ?? deps.store.focusedId
  if (!workspaces.some((w) => w.id === fromId)) {
    throw new Error(`The copied nodes' workspace is gone — copy again`)
  }
  const source =
    fromId === deps.store.focusedId
      ? resolveSource(deps, { nodeIds: spec.nodeIds, choices: [] })
      : sourceFromWorkspace(deps, fromId)

  const chosen = source.nodes.filter((n) => spec.nodeIds.includes(n.id))
  const working = chosen.filter(
    (n): n is TerminalNodeData => n.kind === 'terminal' && (deps.isWorking?.(n.id) ?? false)
  )
  if (working.length > 0) {
    const names = working.map((t) => `“${t.name}”`).join(', ')
    throw new Error(`Working agents can't be copied — wait for ${names} to finish`)
  }

  // Identity transfer is for session-less kinds only; a terminal keeping
  // its id would collide with its own still-live session machinery.
  const preserved = new Set(spec.preserveIdentity ?? [])
  if (preserved.size > 0) {
    const badTerminal = chosen.find((n) => preserved.has(n.id) && n.kind === 'terminal')
    if (badTerminal) {
      throw new Error(`Terminals can't transfer identity — “${badTerminal.name}” must re-id`)
    }
  }

  // The mirror image: a session moves only for a TERMINAL that is actually in
  // this paste. Anything else is a caller bug, and a silently ignored carry is
  // the failure this whole path exists to end — the agent would arrive empty
  // and nothing would say so.
  const carrySessions = new Set(spec.carrySessions ?? [])
  for (const id of carrySessions) {
    const node = chosen.find((n) => n.id === id)
    if (!node) throw new Error(`Can't carry a session for '${id}' — it is not in this paste`)
    if (node.kind !== 'terminal') {
      throw new Error(`Only agents carry sessions — “${node.name}” is a ${node.kind}`)
    }
  }

  // An EXPLICIT worktree request: every selected agent must sit in one git
  // repo workdir; a fresh worktree + branch is created for the copies. The
  // user asked for isolation by name, so any failure here throws — never
  // the fork engine's silent in-place fallback.
  let worktreePath: string | null = null
  if (spec.worktree) {
    const rawName = typeof spec.worktree.name === 'string' ? spec.worktree.name.trim() : ''
    if (!rawName) throw new Error('Worktree paste needs a name')
    const terminals = chosen.filter((n): n is TerminalNodeData => n.kind === 'terminal')
    if (terminals.length === 0) {
      throw new Error('Worktree paste needs at least one agent in the selection')
    }
    const cwds = [...new Set(terminals.map((t) => t.cwd))]
    if (cwds.length !== 1) {
      throw new Error('Worktree paste needs every selected agent in ONE workdir')
    }
    const repoDir = cwds[0]
    const info = await deps.git.gitInfo(repoDir).catch(() => null)
    if (!info?.isRepo) {
      throw new Error(`“${repoDir}” is not a git repo — a worktree needs one`)
    }
    const wtSlug = fileSlug(rawName, 'worktree')
    const created = await deps.git.addWorktree(
      repoDir,
      path.join(deps.worktreeRoot, wtSlug),
      `cookrew/${wtSlug}`
    )
    if (!created.ok) {
      throw new Error(`Worktree “${rawName}” failed: ${created.error} — pick a fresh name`)
    }
    worktreePath = created.path
  }

  const targetState = deps.store.workspaceState(target.id)
  // The copy adopts the TARGET's dirs: resolveTargetDir keeps a source cwd
  // only when the target already lists it, else the primary takes over —
  // unless a worktree was requested, which pins every agent there.
  const targetBase = normalizeDirs({ dir: targetState.dir, dirs: targetState.dirs })
  const dirs = worktreePath ? [...targetBase, worktreePath] : targetBase
  const choices: TeamForkChoice[] = worktreePath
    ? chosen
        .filter((n): n is TerminalNodeData => n.kind === 'terminal')
        .map((n) => ({ nodeId: n.id, mode: 'latest' as const, targetDir: worktreePath as string }))
    : []

  const plan = (() => {
    try {
      return planTeamFork(
        source,
        { nodeIds: spec.nodeIds, choices, dirs, worktree: false },
        {
          newId: randomUUID,
          roleOf: (name) => deps.roles.get(name),
          keepIdentity: preserved,
          carrySessions
        }
      )
    } catch (error) {
      // The planner speaks fork; this caller pressed COPY/CUT then PASTE.
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(message.replace(/^Team fork/, 'Team copy'))
    }
  })()

  // A carried terminal is NOT forked, so it gets no fork context: no
  // truncated session copy, no "you are a fork of X" preamble. It already
  // holds the real conversation — the only thing left is to make that
  // conversation resolvable from its new id and workdir (deps.carrySession).
  const contexts = new Map(
    plan.terminals
      .filter((t) => !carrySessions.has(t.source.id))
      .map((t) => [t.newId, resolveTerminalContext(t, source, deps.projectsDir)])
  )
  const nodes = plan.nodes.map((n) => {
    const context = contexts.get(n.id)
    const seeded =
      context && n.kind === 'terminal'
        ? {
            ...n,
            claudeSessionId: context.claudeSessionId,
            // Inactive target: the preamble cannot be injected into a PTY
            // that does not exist yet — stash it on the node for the switch
            // boot to deliver. Without this, every preamble-based agent
            // (Codex, pi, failed native forks) would copy as a hollow fork.
            pendingInject: intoActive ? null : (context.inject ?? null)
          }
        : n
    // A MOVED node (identity transfer) keeps its position too — it is the
    // same card in a new home, not a paste beside something.
    if (preserved.has(seeded.id)) return seeded
    return {
      ...seeded,
      position: { x: seeded.position.x + COPY_NUDGE_PX, y: seeded.position.y + COPY_NUDGE_PX }
    }
  })

  // The worktree dir must be in the target's list BEFORE the nodes land:
  // normalizeState snaps any terminal cwd outside the dir list to the
  // primary on load. This is one extra O(1) patch only for worktree pastes;
  // the team itself lands below as one nodes+cables state mutation.
  if (worktreePath) deps.store.addWorkspaceDir(target.id, worktreePath)
  const added = deps.store.appendTeamToWorkspace(target.id, nodes, plan.connections)

  // Hand each carried conversation to its new card — BEFORE adoptNode, which
  // is what boots the pty. The spawn resolves its session against the new id
  // and the new workdir, so both have to be true by the time it runs; this is
  // the same order the workdir move keeps (carry, then spawn).
  if (deps.carrySession) {
    const newById = new Map(added.map((n) => [n.id, n]))
    for (const t of plan.terminals) {
      if (!carrySessions.has(t.source.id)) continue
      const to = newById.get(t.newId)
      if (to?.kind !== 'terminal') continue
      try {
        deps.carrySession(t.source, to)
      } catch (error) {
        // Never block the paste on it: the card has already landed, and a
        // conversation that failed to follow is a loud log, not a lost node.
        console.error(`Carrying “${t.source.name}” session to the pasted card failed:`, error)
      }
    }
  }

  if (intoActive && deps.adoptNode) {
    for (const node of added) {
      deps.adoptNode(node)
      if (node.kind !== 'terminal') continue
      const inject = contexts.get(node.id)?.inject
      const session = inject ? deps.ptys.get(node.id) : undefined
      if (inject && session) {
        injectWhenReady(session, inject).catch((error) => {
          console.error('Team copy context injection failed:', error)
        })
      }
    }
  }

  return {
    workspaceId: target.id,
    workspaceName: target.name,
    copiedNodes: added.length,
    copiedCables: plan.connections.length,
    // Detached sources aren't turn-tracked (the working guard can't see
    // them and histories are frozen at the last visit) — say so.
    ...(fromId !== deps.store.focusedId ? { staleSource: true } : {})
  }
}
