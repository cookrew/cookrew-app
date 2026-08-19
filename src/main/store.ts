import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  CanvasNode,
  Connection,
  NoteNodeData,
  BrowserNodeData,
  TerminalNodeData,
  WorkspaceList,
  WorkspaceMeta,
  WorkspaceState,
  noteNameFromContent,
  normalizeDirs,
  uniqueName
} from '../shared/model'
import { addDir, removeDir, setPrimary } from '../shared/workspace-dirs'
import type { CookrewEvent, EventActor } from './event-log'
import { upgradeNode } from './node-upgrades'
import type { RecoverableSnapshot } from './recoverable'

const DATA_DIR = path.join(homedir(), '.cookrew')
const LEGACY_DATA_DIR = path.join(homedir(), '.cava')

// One-time migration from the pre-brand-merge data dir (~/.cava). Must run
// before anything touches DATA_DIR, so it lives at module scope — store.ts is
// the first main-process module imported that persists state.
if (!existsSync(DATA_DIR) && existsSync(LEGACY_DATA_DIR)) {
  try {
    renameSync(LEGACY_DATA_DIR, DATA_DIR)
  } catch (error) {
    console.error('Failed to migrate legacy data dir ~/.cava:', error)
  }
}
/**
 * A duration is a finite, non-negative count of milliseconds — anything else
 * is dropped rather than emitted (CookrewEvent.durationMs). One definition,
 * at the choke-point every emitter passes through, so no caller can put a NaN
 * or a negative into the log and skew every percentile ranked above it. A
 * clock that ran backwards is not a measurement; it is the absence of one.
 */
function isDuration(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

// All persistence paths derive from a base dir so tests can run a store
// against a temp directory instead of the real ~/.cookrew.
const registryFile = (base: string): string => path.join(base, 'registry.json')
const workspacesDir = (base: string): string => path.join(base, 'workspaces')
const legacyWorkspaceFile = (base: string): string => path.join(base, 'workspace.json')
const legacyNotesDir = (base: string): string => path.join(base, 'notes')

interface Registry {
  workspaces: WorkspaceMeta[]
  /**
   * Last-focused workspace — a BOOT HINT, not the authority it used to be.
   *
   * It survives on disk under the old name so an existing registry.json keeps
   * working, but nothing reads it after construction. Which workspaces are
   * live is now residency (see `hydrated`); which one a seat is looking at is
   * focus, and once windows exist (step 3) focus is per-window, so a single
   * persisted value cannot express it.
   */
  activeId: string
}

/** Options a caller may pin; everything else is derived. */
export interface WorkspaceStoreOptions {
  /**
   * Hold more than one workspace hydrated at a time (marketplace §11).
   * OFF is today's behaviour exactly: switching evicts the workspace you left.
   */
  multiInstance?: boolean
}

/** A workspace the process is holding in memory. */
interface HydratedSession {
  state: WorkspaceState
  /** Debounced save, bound to THIS workspace — never re-resolved at fire time. */
  saveTimer: NodeJS.Timeout | null
}

const MULTI_INSTANCE_DEFAULT = process.env.COOKREW_MULTI_INSTANCE === '1'

/** A node found by a cross-workspace lookup, with its owning workspace. */
export interface WorkspaceNodeHit {
  node: CanvasNode
  workspaceId: string
}

/**
 * Source of truth for the active workspace (nodes/connections/notes) plus the
 * registry of all workspaces. Each workspace has its own directory under
 * ~/.cookrew/workspaces/<id>/ holding workspace.json and notes/*.md. Switching
 * saves the current workspace, loads the target, and emits 'switch' so the
 * main process can rebuild PTYs for the new canvas.
 */
export class WorkspaceStore extends EventEmitter {
  private registry: Registry

  /**
   * Workspaces held in memory. Was a single `state` field — the one thing
   * marketplace-architecture §11 calls the singleton, because it made "live"
   * and "looked at" the same word.
   */
  private readonly hydrated = new Map<string, HydratedSession>()

  /** Which resident workspace a seat is looking at. A label, not a lifetime. */
  private focused: string

  private readonly multiInstance: boolean

  constructor(private baseDir = DATA_DIR, options: WorkspaceStoreOptions = {}) {
    super()
    this.multiInstance = options.multiInstance ?? MULTI_INSTANCE_DEFAULT
    this.registry = loadRegistry(this.baseDir)
    // The persisted hint may name a workspace that no longer exists — another
    // window's registry write, or a hand edit. Focus must still land somewhere.
    const hint = this.registry.activeId
    this.focused = this.registry.workspaces.some((w) => w.id === hint)
      ? hint
      : this.registry.workspaces[0].id
    this.hydrate(this.focused)
  }

  // ---- residency ----

  /**
   * The session for a workspace, loading it if the store is not already
   * holding one. Nothing is retained if the load throws.
   */
  private hydrate(id: string): HydratedSession {
    const existing = this.hydrated.get(id)
    if (existing) return existing
    const session: HydratedSession = {
      state: loadWorkspaceState(this.baseDir, id),
      saveTimer: null
    }
    this.hydrated.set(id, session)
    return session
  }

  /** Workspace ids currently held in memory. */
  resident(): string[] {
    return [...this.hydrated.keys()]
  }

  private isResident(id: string): boolean {
    return this.hydrated.has(id)
  }

  /**
   * Stop holding a workspace, flushing it first — an evicted edit must never
   * be a lost edit. No-op if it was not resident.
   */
  private evict(id: string): void {
    const session = this.hydrated.get(id)
    if (!session) return
    this.flushSession(id, session)
    this.hydrated.delete(id)
  }

  /** Test seam: the data dir this store was built against. */
  get baseDirForTests(): string {
    return this.baseDir
  }

  // ---- workspace registry ----

  /** Which workspace a seat is looking at. */
  get focusedId(): string {
    return this.focused
  }

  /** The focused workspace's canvas. */
  get focusedState(): WorkspaceState {
    return this.hydrate(this.focused).state
  }

  /** Meta of the focused workspace, or undefined if the registry is empty. */
  focusedMeta(): WorkspaceMeta | undefined {
    return this.registry.workspaces.find((w) => w.id === this.focused)
  }

  list(): WorkspaceList {
    return { workspaces: this.registry.workspaces, activeId: this.focused }
  }

  activeMeta(): WorkspaceMeta {
    return this.focusedMeta() ?? this.registry.workspaces[0]
  }

  metaByName(name: string): WorkspaceMeta | undefined {
    return this.registry.workspaces.find((w) => w.name.toLowerCase() === name.toLowerCase())
  }

  createWorkspace(name: string, dir: string, icon = '🗂'): WorkspaceMeta {
    const finalName = uniqueName(
      name.trim() || 'Workspace',
      this.registry.workspaces.map((w) => w.name)
    )
    const meta: WorkspaceMeta = { id: randomUUID(), name: finalName, dir, dirs: [dir], icon }
    this.registry = { ...this.registry, workspaces: [...this.registry.workspaces, meta] }
    // Seed an empty canvas file so the switch loads cleanly.
    saveWorkspaceState(this.baseDir, meta.id, { name: meta.name, dir, dirs: [dir], nodes: [], connections: [] })
    saveRegistry(this.baseDir, this.registry)
    this.emit('workspaces', this.list())
    this.emitOp('workspace.created', meta.id, meta.name, meta.id)
    return meta
  }

  /**
   * Create a workspace pre-seeded with nodes and connections (team fork).
   * Note bodies are mirrored as real .md files like persistNoteFile does for
   * the active workspace. Does NOT switch — callers switch when ready.
   */
  createWorkspaceWithState(
    name: string,
    dir: string,
    nodes: CanvasNode[],
    connections: Connection[],
    icon = '⑂',
    dirs?: string[]
  ): WorkspaceMeta {
    const finalName = uniqueName(
      name.trim() || 'Workspace',
      this.registry.workspaces.map((w) => w.name)
    )
    const finalDirs = normalizeDirs({ dir, dirs })
    const primary = finalDirs[0] ?? dir
    const meta: WorkspaceMeta = { id: randomUUID(), name: finalName, dir: primary, dirs: finalDirs, icon }
    this.registry = { ...this.registry, workspaces: [...this.registry.workspaces, meta] }
    saveWorkspaceState(this.baseDir, meta.id, { name: finalName, dir: primary, dirs: finalDirs, nodes, connections })
    try {
      const notesDir = path.join(workspacesDir(this.baseDir), meta.id, 'notes')
      const notes = nodes.filter((n): n is NoteNodeData => n.kind === 'note')
      if (notes.length > 0) mkdirSync(notesDir, { recursive: true })
      for (const note of notes) {
        writeFileSync(path.join(notesDir, `${note.id}.md`), note.content, 'utf8')
      }
    } catch (error) {
      console.error('Failed to mirror forked note files:', error)
    }
    saveRegistry(this.baseDir, this.registry)
    this.emit('workspaces', this.list())
    this.emitOp('workspace.created', meta.id, meta.name, meta.id, 'team fork')
    return meta
  }

  /**
   * Persist the current workspace, load the target, and emit 'switch' with the
   * outgoing terminal ids so the caller can tear down their PTYs. Returns the
   * target meta, or throws if the id is unknown.
   */
  switchWorkspace(id: string): WorkspaceMeta {
    const target = this.registry.workspaces.find((w) => w.id === id)
    if (!target) throw new Error(`Workspace '${id}' not found`)
    if (id === this.focused) return target

    // The clock starts at INITIATION and stops after the 'switch' listener has
    // run, because that listener is the switch: index.ts detaches the outgoing
    // PTYs and boots the incoming ones inside it, synchronously. Timing only
    // the bookkeeping above would report a couple of milliseconds for
    // something the user waits seconds on.
    const startedAt = Date.now()
    const previousTerminalIds = this.terminals().map((t) => t.id)
    const leaving = this.focused

    this.focused = id
    // The hint, so the next boot opens where this one left off. Focus itself
    // stops living on disk here — once windows exist it is per-window, and one
    // persisted value cannot say what two windows are looking at.
    this.registry = { ...this.registry, activeId: id }
    saveRegistry(this.baseDir, this.registry)
    this.hydrate(id)

    // Flag OFF is today's behaviour exactly: one workspace resident, the one
    // you left dropped (flushed first). Flag ON keeps it hydrated, which is
    // the whole point — the work you looked away from is still there.
    if (this.multiInstance) {
      const session = this.hydrated.get(leaving)
      if (session) this.flushSession(leaving, session)
    } else {
      this.evict(leaving)
    }

    this.emit('switch', { previousTerminalIds })
    this.emit('workspaces', this.list())
    this.emit('change', this.focusedState)
    this.emitOp(
      'workspace.switched',
      target.id,
      target.name,
      target.id,
      undefined,
      Date.now() - startedAt
    )
    return target
  }

  renameWorkspace(id: string, name: string): void {
    this.registry = {
      ...this.registry,
      workspaces: this.registry.workspaces.map((w) => (w.id === id ? { ...w, name } : w))
    }
    // A rename lands on the canvas wherever it is held, focused or not.
    const session = this.hydrated.get(id)
    if (session) session.state = { ...session.state, name }
    saveRegistry(this.baseDir, this.registry)
    this.emit('workspaces', this.list())
    if (id === this.focused) this.emit('change', this.focusedState)
    this.emitOp('workspace.renamed', id, name, id)
  }

  /**
   * Delete a workspace and its on-disk state/notes. Never removes the last
   * workspace; if the removed one is active, switches to another first (the
   * caller's 'switch' handler rebuilds PTYs). Returns the switch target id
   * when a switch happened, else null.
   */
  removeWorkspace(id: string): string | null {
    if (this.registry.workspaces.length <= 1) {
      throw new Error('Cannot remove the last workspace')
    }
    if (!this.registry.workspaces.some((w) => w.id === id)) {
      throw new Error(`Workspace '${id}' not found`)
    }
    let switchedTo: string | null = null
    if (id === this.focused) {
      const other = this.registry.workspaces.find((w) => w.id !== id)
      if (other) {
        this.switchWorkspace(other.id) // saves current, boots the target
        switchedTo = other.id
      }
    }
    // Stop holding it BEFORE the files go: a resident session whose partition
    // has been deleted would keep rewriting the directory from its save timer.
    const doomed = this.hydrated.get(id)
    if (doomed) {
      if (doomed.saveTimer) clearTimeout(doomed.saveTimer)
      this.hydrated.delete(id)
    }
    const removedMeta = this.registry.workspaces.find((w) => w.id === id)
    this.registry = {
      ...this.registry,
      workspaces: this.registry.workspaces.filter((w) => w.id !== id)
    }
    saveRegistry(this.baseDir, this.registry)
    this.emitOp('workspace.deleted', id, removedMeta?.name ?? id, id)
    try {
      rmSync(path.join(workspacesDir(this.baseDir), id), { recursive: true, force: true })
    } catch (error) {
      console.error('Failed to delete workspace files:', error)
    }
    this.emit('workspaces', this.list())
    return switchedTo
  }

  // ---- workspace directories (multi-dir model) ----

  /** Working directories of the active workspace, primary first. */
  dirs(): string[] {
    return this.focusedState.dirs
  }

  private applyDirs(id: string, nextDirs: string[]): WorkspaceList {
    const dirs = normalizeDirs({ dirs: nextDirs })
    if (dirs.length === 0) throw new Error('A workspace must keep at least one directory')
    const primary = dirs[0]
    this.registry = {
      ...this.registry,
      workspaces: this.registry.workspaces.map((w) =>
        w.id === id ? { ...w, dir: primary, dirs } : w
      )
    }
    const session = this.hydrated.get(id)
    if (session) {
      this.mutateIn(id, { ...session.state, dir: primary, dirs })
    } else {
      // Not held in memory: patch its on-disk state directly.
      const state = loadWorkspaceState(this.baseDir, id)
      saveWorkspaceState(this.baseDir, id, { ...state, dir: primary, dirs })
    }
    saveRegistry(this.baseDir, this.registry)
    this.emit('workspaces', this.list())
    return this.list()
  }

  private workspaceDirs(id: string): string[] {
    const meta = this.registry.workspaces.find((w) => w.id === id)
    if (!meta) throw new Error(`Workspace '${id}' not found`)
    return this.hydrated.get(id)?.state.dirs ?? meta.dirs
  }

  addWorkspaceDir(id: string, dir: string): WorkspaceList {
    return this.applyDirs(id, addDir(this.workspaceDirs(id), dir))
  }

  removeWorkspaceDir(id: string, dir: string): WorkspaceList {
    const inUse =
      this.hydrated.has(id) &&
      this.stateOf(id).nodes.some((n) => n.kind === 'terminal' && n.cwd === dir)
    return this.applyDirs(id, removeDir(this.workspaceDirs(id), dir, inUse))
  }

  setPrimaryDir(id: string, dir: string): WorkspaceList {
    return this.applyDirs(id, setPrimary(this.workspaceDirs(id), dir))
  }

  /** Repoint a terminal's cwd to one of the workspace's directories. */
  setTerminalCwd(nodeId: string, dir: string): TerminalNodeData {
    const node = this.node(nodeId)
    if (!node || node.kind !== 'terminal') throw new Error('Not a terminal node')
    if (!this.focusedState.dirs.includes(dir)) {
      throw new Error(`'${dir}' is not a directory of this workspace`)
    }
    return this.updateNodeUnsafe(nodeId, { cwd: dir }) as TerminalNodeData
  }

  // ---- resident-workspace state ----

  /**
   * Replace a resident workspace's canvas, emitting 'change' only when it is
   * the one being looked at — a background edit is real, but no seat is
   * rendering it.
   */
  private mutateIn(workspaceId: string, next: WorkspaceState): void {
    const session = this.hydrate(workspaceId)
    session.state = next
    if (workspaceId === this.focused) this.emit('change', next)
    this.scheduleSave(workspaceId)
  }

  private mutate(next: WorkspaceState): void {
    this.mutateIn(this.focused, next)
  }

  /**
   * Debounce a save for ONE workspace.
   *
   * The target is captured HERE, at schedule time, rather than read from focus
   * when the timer fires. The old code did the latter and stayed correct only
   * because switchWorkspace flushed before moving focus; with N sessions
   * resident that ordering guarantee is gone, and a save landing under
   * whichever workspace happened to be focused 300ms later would corrupt both.
   */
  private scheduleSave(workspaceId: string): void {
    const session = this.hydrated.get(workspaceId)
    if (!session) return
    if (session.saveTimer) clearTimeout(session.saveTimer)
    session.saveTimer = setTimeout(() => {
      session.saveTimer = null
      saveWorkspaceState(this.baseDir, workspaceId, session.state)
    }, 300)
  }

  private flushSession(workspaceId: string, session: HydratedSession): void {
    if (session.saveTimer) {
      clearTimeout(session.saveTimer)
      session.saveTimer = null
    }
    saveWorkspaceState(this.baseDir, workspaceId, session.state)
  }

  /**
   * Write every resident workspace's debounced state now (app quit) — a node
   * change within the 300ms save window would otherwise be lost. All of them,
   * not just the focused one: a background session's work is no less real.
   */
  flush(): void {
    for (const [id, session] of this.hydrated) this.flushSession(id, session)
  }

  /** Notes directory of ANY workspace — resident or not. */
  notesDirOf(workspaceId: string): string {
    return path.join(workspacesDir(this.baseDir), workspaceId, 'notes')
  }

  // ---- lookups ----

  node(id: string): CanvasNode | undefined {
    return this.focusedState.nodes.find((n) => n.id === id)
  }

  nodeByName(name: string, kind?: CanvasNode['kind']): CanvasNode | undefined {
    return this.focusedState.nodes.find(
      (n) => n.name.toLowerCase() === name.toLowerCase() && (!kind || n.kind === kind)
    )
  }

  /**
   * The workspace a node id lives in, across ALL workspaces — the active one
   * first, then each inactive workspace's persisted state. Error paths use it
   * to tell a user their terminal lives in workspace A while B is active
   * (node()/terminals() are active-scoped and can't see across the switch).
   * Returns undefined when no workspace contains the node.
   */
  workspaceOfNode(id: string): WorkspaceMeta | undefined {
    if (this.focusedState.nodes.some((n) => n.id === id)) return this.activeMeta()
    for (const meta of this.registry.workspaces) {
      if (meta.id === this.focused) continue
      try {
        const raw = JSON.parse(
          readFileSync(workspaceFile(this.baseDir, meta.id), 'utf8')
        ) as WorkspaceState
        if (raw.nodes?.some((n) => n.id === id)) return meta
      } catch {
        // Unreadable/missing workspace file — skip it.
      }
    }
    return undefined
  }

  terminals(): TerminalNodeData[] {
    return this.focusedState.nodes.filter((n): n is TerminalNodeData => n.kind === 'terminal')
  }

  notes(): NoteNodeData[] {
    return this.focusedState.nodes.filter((n): n is NoteNodeData => n.kind === 'note')
  }

  browsers(): BrowserNodeData[] {
    return this.focusedState.nodes.filter((n): n is BrowserNodeData => n.kind === 'browser')
  }

  /** Everything directly connected to the given node id. */
  connectedTo(id: string): CanvasNode[] {
    const ids = this.focusedState.connections
      .filter((c) => c.a === id || c.b === id)
      .map((c) => (c.a === id ? c.b : c.a))
    return ids.map((nid) => this.node(nid)).filter((n): n is CanvasNode => n !== undefined)
  }

  isConnected(aId: string, bId: string): boolean {
    return this.focusedState.connections.some(
      (c) => (c.a === aId && c.b === bId) || (c.a === bId && c.b === aId)
    )
  }

  // ---- observability choke-point (note observability-event-log-spec) ----
  //
  // EVERY mutating op below funnels through emitOp, so the 'op' event stream
  // can never diverge from state. index.ts appends the stream to the durable
  // EventLog and broadcasts it (renderer + mobile SSE). Metadata only.

  private opContext: { actor: EventActor; via: string | null } = { actor: 'user', via: null }

  /**
   * Scope actor/via labels around SYNCHRONOUS store calls (all mutations are
   * sync): the CLI wraps orch verbs (recruit/dismiss/fork) so their events
   * carry the acting party and a semantic type refinement.
   */
  withOpContext<T>(ctx: { actor?: EventActor; via?: string | null }, fn: () => T): T {
    const previous = this.opContext
    this.opContext = { ...previous, ...ctx }
    try {
      return fn()
    } finally {
      this.opContext = previous
    }
  }

  private emitOp(
    type: string,
    entityId: string,
    entityName: string,
    workspaceId: string,
    details?: string,
    durationMs?: number
  ): void {
    const ws = this.registry.workspaces.find((w) => w.id === workspaceId)
    const event: CookrewEvent = {
      type,
      entityId,
      entityName,
      workspaceId,
      workspaceName: ws?.name ?? workspaceId,
      actor: this.opContext.actor,
      timestamp: Date.now(),
      ...(details !== undefined ? { details } : {}),
      ...(isDuration(durationMs) ? { durationMs } : {})
    }
    this.emit('op', event)
  }

  // Recovery snapshot hook (agent-recover): captured just before a terminal
  // node is hard-removed, so recoverAgent can restore it as it was.
  private onTerminalRemoved: ((snapshot: RecoverableSnapshot) => void) | null = null
  setTerminalRemovedHook(fn: (snapshot: RecoverableSnapshot) => void): void {
    this.onTerminalRemoved = fn
  }

  /**
   * Snapshot a terminal for recovery ahead of an EXTERNAL kill that bypasses
   * removeNode — notably workspace delete, which kills tmux + rm's the state
   * dir directly (HIGH-1). Resolves the node across workspaces so an inactive
   * workspace's terminals are captured too.
   */
  snapshotTerminal(id: string): void {
    const hit = this.nodeAcrossWorkspaces(id)
    if (hit && hit.node.kind === 'terminal') this.captureRecoverable(hit.node, hit.workspaceId)
  }

  private captureRecoverable(node: CanvasNode, workspaceId: string): void {
    if (!this.onTerminalRemoved || node.kind !== 'terminal') return
    const workspaceName =
      this.registry.workspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId
    const peers = this.connectedToAcross(node.id).map((h) => h.node.id)
    this.onTerminalRemoved({
      node,
      workspaceId,
      workspaceName,
      peers,
      savedAt: Date.now()
    })
  }

  /**
   * Ops living outside the store (role/team saves, a turn completing in the
   * tracker) still go through here — one choke-point, so the event stream can
   * never diverge from state. `durationMs` is how a caller that measured
   * something reports it; omit it and the event is untimed, as before.
   */
  /**
   * Ops living outside the store (a rotation rebind, a turn completing in
   * the tracker) still go through here — one choke-point, so the event
   * stream can never diverge from state, even for background workspaces.
   */
  recordEventIn(
    workspaceId: string,
    type: string,
    entityId: string,
    entityName: string,
    details?: string,
    durationMs?: number
  ): void {
    if (!this.registry.workspaces.some((workspace) => workspace.id === workspaceId)) {
      throw new Error(`Workspace '${workspaceId}' not found`)
    }
    this.emitOp(type, entityId, entityName, workspaceId, details, durationMs)
  }

  recordEvent(
    type: string,
    entityId: string,
    entityName: string,
    details?: string,
    durationMs?: number
  ): void {
    this.recordEventIn(this.focused, type, entityId, entityName, details, durationMs)
  }

  private createdType(kind: CanvasNode['kind']): string {
    if (kind === 'terminal') {
      if (this.opContext.via === 'recruit') return 'terminal.recruited'
      if (this.opContext.via === 'fork') return 'terminal.forked'
      return 'terminal.created'
    }
    return kind === 'note' ? 'note.created' : 'browser.created'
  }

  private removedType(kind: CanvasNode['kind']): string {
    if (kind === 'terminal') {
      return this.opContext.via === 'dismiss' ? 'terminal.dismissed' : 'terminal.killed'
    }
    return kind === 'note' ? 'note.deleted' : 'browser.closed'
  }

  // ---- cross-workspace lookups & edges (orchestration spans canvases) ----
  //
  // Edges between nodes of different workspaces are MIRRORED: the same
  // Connection {id,a,b} lives in BOTH endpoint workspaces' lists (decision
  // in note cross-workspace-orch-fix-dec). Renderers drop edges whose far
  // endpoint is not on the local canvas; the store resolves them here.

  /** Active workspace state from memory (fresh), inactive from disk. */
  private stateOf(id: string): WorkspaceState {
    return this.hydrated.get(id)?.state ?? loadWorkspaceState(this.baseDir, id)
  }

  /** Read-only state of ANY workspace (active from memory, inactive from disk). */
  workspaceState(id: string): WorkspaceState {
    return this.stateOf(id)
  }

  /** Terminal node ids of ONE workspace (active from memory, inactive from disk). */
  terminalIdsOf(workspaceId: string): string[] {
    return this.stateOf(workspaceId)
      .nodes.filter((n) => n.kind === 'terminal')
      .map((n) => n.id)
  }

  /** Terminal node ids across ALL workspaces — the sessions the app owns. */
  allTerminalIds(): string[] {
    const ids: string[] = []
    for (const w of this.registry.workspaces) {
      for (const n of this.stateOf(w.id).nodes) {
        if (n.kind === 'terminal') ids.push(n.id)
      }
    }
    return ids
  }

  /**
   * Strict variant for the orphan reaper: a workspace file that exists but
   * fails to load THROWS instead of contributing an empty node list. The
   * lenient loader is right for rendering (a corrupt file shouldn't crash the
   * UI), but the reaper must fail SAFE — treating a parked team's terminals
   * as unowned because its JSON was momentarily corrupt would kill them.
   * A legitimately-absent file still counts as an empty workspace.
   */
  allTerminalIdsStrict(): string[] {
    const ids: string[] = []
    for (const w of this.registry.workspaces) {
      const state =
        this.hydrated.get(w.id)?.state ?? loadWorkspaceStateStrict(this.baseDir, w.id)
      for (const n of state.nodes) {
        if (n.kind === 'terminal') ids.push(n.id)
      }
    }
    return ids
  }

  /** Apply a transform to any workspace: active mutates, inactive patches disk. */
  private patchWorkspace(id: string, fn: (s: WorkspaceState) => WorkspaceState): void {
    const session = this.hydrated.get(id)
    if (session) {
      this.mutateIn(id, fn(session.state))
      return
    }
    saveWorkspaceState(this.baseDir, id, fn(this.stateOf(id)))
  }

  /** Workspace metas with the active one first (cheapest, freshest lookup). */
  private metasActiveFirst(): WorkspaceMeta[] {
    return [...this.registry.workspaces].sort((a, b) =>
      this.hydrated.has(a.id) === this.hydrated.has(b.id) ? 0 : this.hydrated.has(a.id) ? -1 : 1
    )
  }

  /** Every terminal across ALL workspaces (codex bind exclusion scans). */
  terminalsAcross(): TerminalNodeData[] {
    return this.metasActiveFirst().flatMap((m) =>
      this.stateOf(m.id).nodes.filter((n): n is TerminalNodeData => n.kind === 'terminal')
    )
  }

  /** Node lookup across EVERY workspace, not just the active canvas. */
  nodeAcrossWorkspaces(id: string): WorkspaceNodeHit | undefined {
    for (const meta of this.metasActiveFirst()) {
      const node = this.stateOf(meta.id).nodes.find((n) => n.id === id)
      if (node) return { node, workspaceId: meta.id }
    }
    return undefined
  }

  /**
   * The workspace that OWNS a node, across every workspace.
   *
   * The CLI's resolver. A `cookrew` command arrives from inside a pane, so the
   * caller's terminal id already says which workspace the command is about —
   * the process never has to consult what anyone is looking at. That is the
   * whole reason the CLI socket can stay global while its scope goes
   * per-session (marketplace-architecture §11).
   */
  ownerOf(nodeId: string): string | undefined {
    return this.nodeAcrossWorkspaces(nodeId)?.workspaceId
  }

  workspaceOf(nodeId: string): WorkspaceMeta | undefined {
    const hit = this.nodeAcrossWorkspaces(nodeId)
    return hit ? this.registry.workspaces.find((w) => w.id === hit.workspaceId) : undefined
  }

  /**
   * connectedTo across every workspace: unions edges mentioning the id from
   * all workspace states and resolves endpoints globally. Mirror edges left
   * dangling by a deletion in the other workspace are filtered at read time.
   */
  connectedToAcross(id: string): WorkspaceNodeHit[] {
    const states = this.metasActiveFirst().map((m) => ({ id: m.id, state: this.stateOf(m.id) }))
    const resolve = (nid: string): WorkspaceNodeHit | undefined => {
      for (const s of states) {
        const node = s.state.nodes.find((n) => n.id === nid)
        if (node) return { node, workspaceId: s.id }
      }
      return undefined
    }
    const seen = new Set<string>()
    const hits: WorkspaceNodeHit[] = []
    for (const s of states) {
      for (const c of s.state.connections) {
        if (c.a !== id && c.b !== id) continue
        const otherId = c.a === id ? c.b : c.a
        if (seen.has(otherId)) continue
        seen.add(otherId)
        const hit = resolve(otherId)
        if (hit) hits.push(hit)
      }
    }
    return hits
  }

  /** Connect two nodes wherever they live; cross-workspace edges get mirrored. */
  connectAcross(aId: string, bId: string): Connection {
    const a = this.nodeAcrossWorkspaces(aId)
    const b = this.nodeAcrossWorkspaces(bId)
    if (!a || !b) throw new Error('Cannot connect: node not found in any workspace')
    if (a.workspaceId === this.focused && b.workspaceId === this.focused) {
      return this.connect(aId, bId)
    }
    const matches = (c: Connection): boolean =>
      (c.a === aId && c.b === bId) || (c.a === bId && c.b === aId)
    const existing =
      this.stateOf(a.workspaceId).connections.find(matches) ??
      this.stateOf(b.workspaceId).connections.find(matches)
    const conn = existing ?? { id: randomUUID(), a: aId, b: bId }
    for (const wsId of new Set([a.workspaceId, b.workspaceId])) {
      this.patchWorkspace(wsId, (s) =>
        s.connections.some(matches) ? s : { ...s, connections: [...s.connections, conn] }
      )
    }
    // ONE event per logical edge — the mirror write is the same connection.
    if (!existing) {
      this.emitOp(
        'connection.made',
        conn.id,
        `${a.node.name} ↔ ${b.node.name}`,
        a.workspaceId
      )
    }
    return conn
  }

  /** addNode into any workspace; unique-named within THAT workspace. */
  addNodeToWorkspace(workspaceId: string, node: CanvasNode): CanvasNode {
    if (workspaceId === this.focused) return this.addNode(node)
    if (!this.registry.workspaces.some((w) => w.id === workspaceId)) {
      throw new Error(`Workspace '${workspaceId}' not found`)
    }
    const state = this.stateOf(workspaceId)
    const named: CanvasNode = {
      ...node,
      name: uniqueName(node.name, state.nodes.map((n) => n.name))
    }
    // Residency-aware: a workspace held in memory must be patched THERE, or
    // its next flush writes the pre-add state straight back over this one.
    this.patchWorkspace(workspaceId, (current) => ({
      ...current,
      nodes: [...current.nodes, named]
    }))
    if (named.kind === 'note') void this.persistNoteFile(named, workspaceId)
    this.emitOp(
      this.createdType(named.kind),
      named.id,
      named.name,
      workspaceId,
      named.kind === 'terminal' ? (named as TerminalNodeData).preset : undefined
    )
    return named
  }

  /**
   * Append one copied team to a workspace in ONE state mutation. Unlike the
   * ordinary add/connect APIs this deliberately emits no per-item operation
   * events: the paste boundary owns one `team.copied` / `team.moved` summary.
   *
   * `copyTeam` only passes cables whose endpoints are in `nodes`, so no edge
   * mirroring or cross-workspace lookup is needed here. Names are still made
   * unique sequentially, exactly as N calls to addNodeToWorkspace would be.
   */
  appendTeamToWorkspace(
    workspaceId: string,
    nodes: CanvasNode[],
    connections: Connection[]
  ): CanvasNode[] {
    if (!this.registry.workspaces.some((w) => w.id === workspaceId)) {
      throw new Error(`Workspace '${workspaceId}' not found`)
    }
    let added: CanvasNode[] = []
    this.patchWorkspace(workspaceId, (current) => {
      const names = current.nodes.map((n) => n.name)
      added = nodes.map((node) => {
        const named = { ...node, name: uniqueName(node.name, names) } as CanvasNode
        names.push(named.name)
        return named
      })
      const addedIds = new Set(added.map((node) => node.id))
      const innerConnections = connections.filter(
        (connection) => addedIds.has(connection.a) && addedIds.has(connection.b)
      )
      return {
        ...current,
        nodes: [...current.nodes, ...added],
        connections: [...current.connections, ...innerConnections]
      }
    })

    // Preserve addNode's note-file side effect on the active workspace. The
    // JSON state is already durable; these mirrors remain best-effort async.
    for (const node of added) {
      if (node.kind === 'note') void this.persistNoteFile(node, workspaceId)
    }
    return added
  }

  /**
   * Remove nodes (and their local cables) from ONE workspace's state in a
   * single patch — the cut/paste flow owns the lifecycle: no recoverable
   * capture (the content lives on in the paste), no per-node events (the
   * caller records one team.moved summary), and no cross-workspace lookup
   * (identity-moved nodes exist in the TARGET under the same id).
   */
  removeNodesFromWorkspace(workspaceId: string, ids: string[]): void {
    const gone = new Set(ids)
    this.patchWorkspace(workspaceId, (s) => ({
      ...s,
      nodes: s.nodes.filter((n) => !gone.has(n.id)),
      connections: s.connections.filter((c) => !gone.has(c.a) && !gone.has(c.b))
    }))
  }

  /** Remove a node (and its local edges) from its OWNING workspace. */
  removeNodeAcross(id: string): void {
    const hit = this.nodeAcrossWorkspaces(id)
    if (!hit) return
    // Active-workspace removals route through removeNode so the op event
    // (and any kind-specific cleanup) is emitted exactly once.
    if (hit.workspaceId === this.focused) {
      this.removeNode(id)
      return
    }
    this.captureRecoverable(hit.node, hit.workspaceId)
    this.patchWorkspace(hit.workspaceId, (s) => ({
      ...s,
      nodes: s.nodes.filter((n) => n.id !== id),
      connections: s.connections.filter((c) => c.a !== id && c.b !== id)
    }))
    this.emitOp(this.removedType(hit.node.kind), hit.node.id, hit.node.name, hit.workspaceId)
  }

  // ---- mutations ----

  addNode(node: CanvasNode): CanvasNode {
    const named: CanvasNode = {
      ...node,
      name: uniqueName(node.name, this.focusedState.nodes.map((n) => n.name))
    }
    this.mutate({ ...this.focusedState, nodes: [...this.focusedState.nodes, named] })
    if (named.kind === 'note') void this.persistNoteFile(named)
    this.emitOp(
      this.createdType(named.kind),
      named.id,
      named.name,
      this.focused,
      named.kind === 'terminal' ? (named as TerminalNodeData).preset : undefined
    )
    return named
  }

  /**
   * Externally-patchable fields per node kind (SECURITY: the renderer IPC
   * and the UNAUTHENTICATED mobile node-update endpoint route through
   * updateNode — session bindings, commands and orch flags must never be
   * plantable from there; internal main-process code uses updateNodeUnsafe).
   */
  private static readonly PATCHABLE: Record<CanvasNode['kind'], ReadonlySet<string>> = {
    terminal: new Set(['name', 'position', 'size', 'role']),
    note: new Set(['name', 'customName', 'content', 'locked', 'position', 'size']),
    browser: new Set(['name', 'url', 'tabs', 'activeTabId', 'position', 'size'])
  }

  /** Allow-listed update — the only mutation surface exposed to IPC/mobile. */
  updateNode(id: string, patch: Partial<CanvasNode>): CanvasNode | undefined {
    const node = this.node(id)
    if (!node) return undefined
    const allowed = WorkspaceStore.PATCHABLE[node.kind]
    const safe = Object.fromEntries(
      Object.entries(patch).filter(([key]) => allowed.has(key))
    ) as Partial<CanvasNode>
    return this.updateNodeUnsafe(id, safe)
  }

  /** Full-field update for MAIN-PROCESS internals (spawn binds, cwd moves). */
  updateNodeUnsafe(id: string, patch: Partial<CanvasNode>): CanvasNode | undefined {
    let updated: CanvasNode | undefined
    const nodes = this.focusedState.nodes.map((n) => {
      if (n.id !== id) return n
      updated = { ...n, ...patch } as CanvasNode
      return updated
    })
    if (!updated) return undefined
    this.mutate({ ...this.focusedState, nodes })
    if (updated.kind === 'note') void this.persistNoteFile(updated)
    return updated
  }

  /**
   * Patch a node wherever it lives — a background workspace's agent rotates
   * its session too, and the rebind must land on the persisted state the
   * next switch will load, not silently miss because the canvas looks away.
   */
  updateNodeAcrossWorkspacesUnsafe(
    id: string,
    patch: Partial<CanvasNode>
  ): CanvasNode | undefined {
    const hit = this.nodeAcrossWorkspaces(id)
    if (!hit) return undefined
    if (hit.workspaceId === this.focused) return this.updateNodeUnsafe(id, patch)
    let updated: CanvasNode | undefined
    this.patchWorkspace(hit.workspaceId, (state) => ({
      ...state,
      nodes: state.nodes.map((node) => {
        if (node.id !== id) return node
        updated = { ...node, ...patch } as CanvasNode
        return updated
      })
    }))
    return updated
  }

  removeNode(id: string): void {
    const node = this.node(id)
    if (node) this.captureRecoverable(node, this.focused)
    this.mutate({
      ...this.focusedState,
      nodes: this.focusedState.nodes.filter((n) => n.id !== id),
      connections: this.focusedState.connections.filter((c) => c.a !== id && c.b !== id)
    })
    if (node) this.emitOp(this.removedType(node.kind), node.id, node.name, this.focused)
  }

  connect(aId: string, bId: string): Connection {
    const existing = this.focusedState.connections.find(
      (c) => (c.a === aId && c.b === bId) || (c.a === bId && c.b === aId)
    )
    if (existing) return existing
    const conn: Connection = { id: randomUUID(), a: aId, b: bId }
    this.mutate({ ...this.focusedState, connections: [...this.focusedState.connections, conn] })
    this.emitOp(
      'connection.made',
      conn.id,
      `${this.node(aId)?.name ?? aId} ↔ ${this.node(bId)?.name ?? bId}`,
      this.focused
    )
    return conn
  }

  disconnect(connectionId: string): void {
    this.mutate({
      ...this.focusedState,
      connections: this.focusedState.connections.filter((c) => c.id !== connectionId)
    })
    this.emitOp('connection.removed', connectionId, '', this.focused)
  }

  // ---- notes ----

  createNote(partial: Omit<NoteNodeData, 'kind' | 'id' | 'name'>): NoteNodeData {
    const name = uniqueName(
      noteNameFromContent(partial.content),
      this.focusedState.nodes.map((n) => n.name)
    )
    const note: NoteNodeData = { kind: 'note', id: randomUUID(), name, ...partial }
    return this.addNode(note) as NoteNodeData
  }

  /** Write note content; renames the note when it has no custom name. */
  writeNote(id: string, content: string): NoteNodeData | undefined {
    const note = this.node(id)
    if (!note || note.kind !== 'note') return undefined
    const name = note.customName
      ? note.name
      : uniqueName(
          noteNameFromContent(content),
          this.focusedState.nodes.filter((n) => n.id !== id).map((n) => n.name)
        )
    return this.updateNode(id, { content, name }) as NoteNodeData
  }

  private async persistNoteFile(note: NoteNodeData, workspaceId = this.focused): Promise<void> {
    try {
      const dir = this.notesDirOf(workspaceId)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `${note.id}.md`), note.content, 'utf8')
    } catch (error) {
      console.error('Failed to persist note file:', error)
    }
  }
}

// ---- persistence ----

function workspaceFile(base: string, id: string): string {
  return path.join(workspacesDir(base), id, 'workspace.json')
}

function loadRegistry(base: string): Registry {
  try {
    if (existsSync(registryFile(base))) {
      const raw = JSON.parse(readFileSync(registryFile(base), 'utf8')) as Registry
      if (raw.workspaces?.length > 0) {
        // Normalize legacy metas (no dirs) to the multi-dir shape.
        const workspaces = raw.workspaces.map((w) => {
          const dirs = normalizeDirs({ dir: w.dir, dirs: w.dirs })
          const finalDirs = dirs.length > 0 ? dirs : [homedir()]
          return { ...w, dir: finalDirs[0], dirs: finalDirs }
        })
        return { ...raw, workspaces }
      }
    }
  } catch (error) {
    console.error('Failed to load registry:', error)
  }
  return migrateOrSeed(base)
}

/** Build the first registry: adopt a legacy single-workspace, or start fresh. */
function migrateOrSeed(base: string): Registry {
  const id = randomUUID()
  mkdirSync(path.join(workspacesDir(base), id), { recursive: true })

  if (existsSync(legacyWorkspaceFile(base))) {
    try {
      const legacy = JSON.parse(readFileSync(legacyWorkspaceFile(base), 'utf8')) as WorkspaceState
      saveWorkspaceState(base, id, legacy)
      // Move the old flat notes dir into the workspace so note files resolve.
      if (existsSync(legacyNotesDir(base)) && !existsSync(path.join(workspacesDir(base), id, 'notes'))) {
        renameSync(legacyNotesDir(base), path.join(workspacesDir(base), id, 'notes'))
      }
      renameSync(legacyWorkspaceFile(base), `${legacyWorkspaceFile(base)}.migrated`)
      const dir = legacy.dir || homedir()
      const dirs = normalizeDirs({ dir, dirs: legacy.dirs })
      const meta: WorkspaceMeta = { id, name: legacy.name || 'My Workspace', dir, dirs, icon: '🗂' }
      const registry: Registry = { workspaces: [meta], activeId: id }
      saveRegistry(base, registry)
      return registry
    } catch (error) {
      console.error('Legacy migration failed, seeding fresh:', error)
    }
  }

  const dir = homedir()
  const meta: WorkspaceMeta = { id, name: 'My Workspace', dir, dirs: [dir], icon: '🗂' }
  saveWorkspaceState(base, id, { name: meta.name, dir, dirs: [dir], nodes: [], connections: [] })
  const registry: Registry = { workspaces: [meta], activeId: id }
  saveRegistry(base, registry)
  return registry
}

/**
 * Normalize a persisted (possibly legacy) workspace state to the multi-dir
 * shape: dirs[] is filled from dir/dirs, dir === dirs[0], and every terminal
 * cwd is pinned to a workspace dir (stray cwds snap to primary).
 */
function normalizeState(state: WorkspaceState): WorkspaceState {
  const dirs = normalizeDirs({ dir: state.dir, dirs: state.dirs })
  const finalDirs = dirs.length > 0 ? dirs : [homedir()]
  const primary = finalDirs[0]
  const nodes = state.nodes.map(upgradeNode).map((n) =>
    n.kind === 'terminal' && !finalDirs.includes(n.cwd) ? { ...n, cwd: primary } : n
  )
  return { ...state, dir: primary, dirs: finalDirs, nodes }
}

function loadWorkspaceState(base: string, id: string): WorkspaceState {
  try {
    const file = workspaceFile(base, id)
    if (existsSync(file)) {
      const state = JSON.parse(readFileSync(file, 'utf8')) as WorkspaceState
      return normalizeState(state)
    }
  } catch (error) {
    console.error('Failed to load workspace state:', error)
  }
  const dir = homedir()
  return { name: 'Workspace', dir, dirs: [dir], nodes: [], connections: [] }
}

/** Like loadWorkspaceState but PROPAGATES load failures (orphan reaper). */
function loadWorkspaceStateStrict(base: string, id: string): WorkspaceState {
  const file = workspaceFile(base, id)
  if (!existsSync(file)) {
    const dir = homedir()
    return { name: 'Workspace', dir, dirs: [dir], nodes: [], connections: [] }
  }
  return normalizeState(JSON.parse(readFileSync(file, 'utf8')) as WorkspaceState)
}

function saveWorkspaceState(base: string, id: string, state: WorkspaceState): void {
  try {
    mkdirSync(path.join(workspacesDir(base), id), { recursive: true })
    writeFileSync(workspaceFile(base, id), JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    console.error('Failed to save workspace state:', error)
  }
}

function saveRegistry(base: string, registry: Registry): void {
  try {
    mkdirSync(base, { recursive: true })
    writeFileSync(registryFile(base), JSON.stringify(registry, null, 2), 'utf8')
  } catch (error) {
    console.error('Failed to save registry:', error)
  }
}
