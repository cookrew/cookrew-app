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
import { upgradeNode } from './node-upgrades'

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
const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json')
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces')
const LEGACY_WORKSPACE = path.join(DATA_DIR, 'workspace.json')
const LEGACY_NOTES = path.join(DATA_DIR, 'notes')

interface Registry {
  workspaces: WorkspaceMeta[]
  activeId: string
}

/**
 * Source of truth for the active workspace (nodes/connections/notes) plus the
 * registry of all workspaces. Each workspace has its own directory under
 * ~/.cookrew/workspaces/<id>/ holding workspace.json and notes/*.md. Switching
 * saves the current workspace, loads the target, and emits 'switch' so the
 * main process can rebuild PTYs for the new canvas.
 */
export class WorkspaceStore extends EventEmitter {
  state: WorkspaceState

  private registry: Registry
  private saveTimer: NodeJS.Timeout | null = null

  constructor() {
    super()
    this.registry = loadRegistry()
    this.state = loadWorkspaceState(this.activeId)
  }

  // ---- workspace registry ----

  get activeId(): string {
    return this.registry.activeId
  }

  list(): WorkspaceList {
    return { workspaces: this.registry.workspaces, activeId: this.registry.activeId }
  }

  activeMeta(): WorkspaceMeta {
    return (
      this.registry.workspaces.find((w) => w.id === this.registry.activeId) ??
      this.registry.workspaces[0]
    )
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
    saveWorkspaceState(meta.id, { name: meta.name, dir, dirs: [dir], nodes: [], connections: [] })
    saveRegistry(this.registry)
    this.emit('workspaces', this.list())
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
    saveWorkspaceState(meta.id, { name: finalName, dir: primary, dirs: finalDirs, nodes, connections })
    try {
      const notesDir = path.join(WORKSPACES_DIR, meta.id, 'notes')
      const notes = nodes.filter((n): n is NoteNodeData => n.kind === 'note')
      if (notes.length > 0) mkdirSync(notesDir, { recursive: true })
      for (const note of notes) {
        writeFileSync(path.join(notesDir, `${note.id}.md`), note.content, 'utf8')
      }
    } catch (error) {
      console.error('Failed to mirror forked note files:', error)
    }
    saveRegistry(this.registry)
    this.emit('workspaces', this.list())
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
    if (id === this.registry.activeId) return target

    const previousTerminalIds = this.terminals().map((t) => t.id)
    this.flushSave()

    this.registry = { ...this.registry, activeId: id }
    saveRegistry(this.registry)
    this.state = loadWorkspaceState(id)

    this.emit('switch', { previousTerminalIds })
    this.emit('workspaces', this.list())
    this.emit('change', this.state)
    return target
  }

  renameWorkspace(id: string, name: string): void {
    this.registry = {
      ...this.registry,
      workspaces: this.registry.workspaces.map((w) => (w.id === id ? { ...w, name } : w))
    }
    if (id === this.registry.activeId) this.state = { ...this.state, name }
    saveRegistry(this.registry)
    this.emit('workspaces', this.list())
    if (id === this.registry.activeId) this.emit('change', this.state)
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
    if (id === this.registry.activeId) {
      const other = this.registry.workspaces.find((w) => w.id !== id)
      if (other) {
        this.switchWorkspace(other.id) // saves current, boots the target
        switchedTo = other.id
      }
    }
    this.registry = {
      ...this.registry,
      workspaces: this.registry.workspaces.filter((w) => w.id !== id)
    }
    saveRegistry(this.registry)
    try {
      rmSync(path.join(WORKSPACES_DIR, id), { recursive: true, force: true })
    } catch (error) {
      console.error('Failed to delete workspace files:', error)
    }
    this.emit('workspaces', this.list())
    return switchedTo
  }

  // ---- workspace directories (multi-dir model) ----

  /** Working directories of the active workspace, primary first. */
  dirs(): string[] {
    return this.state.dirs
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
    if (id === this.registry.activeId) {
      this.state = { ...this.state, dir: primary, dirs }
      this.scheduleSave()
      this.emit('change', this.state)
    } else {
      // Inactive workspace: patch its on-disk state directly.
      const state = loadWorkspaceState(id)
      saveWorkspaceState(id, { ...state, dir: primary, dirs })
    }
    saveRegistry(this.registry)
    this.emit('workspaces', this.list())
    return this.list()
  }

  private workspaceDirs(id: string): string[] {
    const meta = this.registry.workspaces.find((w) => w.id === id)
    if (!meta) throw new Error(`Workspace '${id}' not found`)
    return id === this.registry.activeId ? this.state.dirs : meta.dirs
  }

  addWorkspaceDir(id: string, dir: string): WorkspaceList {
    return this.applyDirs(id, addDir(this.workspaceDirs(id), dir))
  }

  removeWorkspaceDir(id: string, dir: string): WorkspaceList {
    const inUse = id === this.registry.activeId && this.terminals().some((t) => t.cwd === dir)
    return this.applyDirs(id, removeDir(this.workspaceDirs(id), dir, inUse))
  }

  setPrimaryDir(id: string, dir: string): WorkspaceList {
    return this.applyDirs(id, setPrimary(this.workspaceDirs(id), dir))
  }

  /** Repoint a terminal's cwd to one of the workspace's directories. */
  setTerminalCwd(nodeId: string, dir: string): TerminalNodeData {
    const node = this.node(nodeId)
    if (!node || node.kind !== 'terminal') throw new Error('Not a terminal node')
    if (!this.state.dirs.includes(dir)) {
      throw new Error(`'${dir}' is not a directory of this workspace`)
    }
    return this.updateNode(nodeId, { cwd: dir }) as TerminalNodeData
  }

  // ---- active-workspace state ----

  private mutate(next: WorkspaceState): void {
    this.state = next
    this.emit('change', this.state)
    this.scheduleSave()
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      saveWorkspaceState(this.registry.activeId, this.state)
    }, 300)
  }

  private flushSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    saveWorkspaceState(this.registry.activeId, this.state)
  }

  private notesDir(): string {
    return path.join(WORKSPACES_DIR, this.registry.activeId, 'notes')
  }

  // ---- lookups ----

  node(id: string): CanvasNode | undefined {
    return this.state.nodes.find((n) => n.id === id)
  }

  nodeByName(name: string, kind?: CanvasNode['kind']): CanvasNode | undefined {
    return this.state.nodes.find(
      (n) => n.name.toLowerCase() === name.toLowerCase() && (!kind || n.kind === kind)
    )
  }

  terminals(): TerminalNodeData[] {
    return this.state.nodes.filter((n): n is TerminalNodeData => n.kind === 'terminal')
  }

  notes(): NoteNodeData[] {
    return this.state.nodes.filter((n): n is NoteNodeData => n.kind === 'note')
  }

  browsers(): BrowserNodeData[] {
    return this.state.nodes.filter((n): n is BrowserNodeData => n.kind === 'browser')
  }

  /** Everything directly connected to the given node id. */
  connectedTo(id: string): CanvasNode[] {
    const ids = this.state.connections
      .filter((c) => c.a === id || c.b === id)
      .map((c) => (c.a === id ? c.b : c.a))
    return ids.map((nid) => this.node(nid)).filter((n): n is CanvasNode => n !== undefined)
  }

  isConnected(aId: string, bId: string): boolean {
    return this.state.connections.some(
      (c) => (c.a === aId && c.b === bId) || (c.a === bId && c.b === aId)
    )
  }

  // ---- mutations ----

  addNode(node: CanvasNode): CanvasNode {
    const named: CanvasNode = {
      ...node,
      name: uniqueName(node.name, this.state.nodes.map((n) => n.name))
    }
    this.mutate({ ...this.state, nodes: [...this.state.nodes, named] })
    if (named.kind === 'note') void this.persistNoteFile(named)
    return named
  }

  updateNode(id: string, patch: Partial<CanvasNode>): CanvasNode | undefined {
    let updated: CanvasNode | undefined
    const nodes = this.state.nodes.map((n) => {
      if (n.id !== id) return n
      updated = { ...n, ...patch } as CanvasNode
      return updated
    })
    if (!updated) return undefined
    this.mutate({ ...this.state, nodes })
    if (updated.kind === 'note') void this.persistNoteFile(updated)
    return updated
  }

  removeNode(id: string): void {
    this.mutate({
      ...this.state,
      nodes: this.state.nodes.filter((n) => n.id !== id),
      connections: this.state.connections.filter((c) => c.a !== id && c.b !== id)
    })
  }

  connect(aId: string, bId: string): Connection {
    const existing = this.state.connections.find(
      (c) => (c.a === aId && c.b === bId) || (c.a === bId && c.b === aId)
    )
    if (existing) return existing
    const conn: Connection = { id: randomUUID(), a: aId, b: bId }
    this.mutate({ ...this.state, connections: [...this.state.connections, conn] })
    return conn
  }

  disconnect(connectionId: string): void {
    this.mutate({
      ...this.state,
      connections: this.state.connections.filter((c) => c.id !== connectionId)
    })
  }

  // ---- notes ----

  createNote(partial: Omit<NoteNodeData, 'kind' | 'id' | 'name'>): NoteNodeData {
    const name = uniqueName(
      noteNameFromContent(partial.content),
      this.state.nodes.map((n) => n.name)
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
          this.state.nodes.filter((n) => n.id !== id).map((n) => n.name)
        )
    return this.updateNode(id, { content, name }) as NoteNodeData
  }

  private async persistNoteFile(note: NoteNodeData): Promise<void> {
    try {
      const dir = this.notesDir()
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, `${note.id}.md`), note.content, 'utf8')
    } catch (error) {
      console.error('Failed to persist note file:', error)
    }
  }
}

// ---- persistence ----

function workspaceFile(id: string): string {
  return path.join(WORKSPACES_DIR, id, 'workspace.json')
}

function loadRegistry(): Registry {
  try {
    if (existsSync(REGISTRY_FILE)) {
      const raw = JSON.parse(readFileSync(REGISTRY_FILE, 'utf8')) as Registry
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
  return migrateOrSeed()
}

/** Build the first registry: adopt a legacy single-workspace, or start fresh. */
function migrateOrSeed(): Registry {
  const id = randomUUID()
  mkdirSync(path.join(WORKSPACES_DIR, id), { recursive: true })

  if (existsSync(LEGACY_WORKSPACE)) {
    try {
      const legacy = JSON.parse(readFileSync(LEGACY_WORKSPACE, 'utf8')) as WorkspaceState
      saveWorkspaceState(id, legacy)
      // Move the old flat notes dir into the workspace so note files resolve.
      if (existsSync(LEGACY_NOTES) && !existsSync(path.join(WORKSPACES_DIR, id, 'notes'))) {
        renameSync(LEGACY_NOTES, path.join(WORKSPACES_DIR, id, 'notes'))
      }
      renameSync(LEGACY_WORKSPACE, `${LEGACY_WORKSPACE}.migrated`)
      const dir = legacy.dir || homedir()
      const dirs = normalizeDirs({ dir, dirs: legacy.dirs })
      const meta: WorkspaceMeta = { id, name: legacy.name || 'My Workspace', dir, dirs, icon: '🗂' }
      const registry: Registry = { workspaces: [meta], activeId: id }
      saveRegistry(registry)
      return registry
    } catch (error) {
      console.error('Legacy migration failed, seeding fresh:', error)
    }
  }

  const dir = homedir()
  const meta: WorkspaceMeta = { id, name: 'My Workspace', dir, dirs: [dir], icon: '🗂' }
  saveWorkspaceState(id, { name: meta.name, dir, dirs: [dir], nodes: [], connections: [] })
  const registry: Registry = { workspaces: [meta], activeId: id }
  saveRegistry(registry)
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

function loadWorkspaceState(id: string): WorkspaceState {
  try {
    const file = workspaceFile(id)
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

function saveWorkspaceState(id: string, state: WorkspaceState): void {
  try {
    mkdirSync(path.join(WORKSPACES_DIR, id), { recursive: true })
    writeFileSync(workspaceFile(id), JSON.stringify(state, null, 2), 'utf8')
  } catch (error) {
    console.error('Failed to save workspace state:', error)
  }
}

function saveRegistry(registry: Registry): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf8')
  } catch (error) {
    console.error('Failed to save registry:', error)
  }
}
