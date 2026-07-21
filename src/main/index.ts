import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from './store'
import { PtyManager } from './pty'
import type { PtySession } from './pty'
import { TurnTracker } from './turn-tracker'
import { TurnStore } from './turn-store'
import { summarizeTurn } from './sous'
import { startSocketServer } from './socket-server'
import { RoutineScheduler } from './routines'
import { VoiceEngine } from './voice'
import { startMobileServer, mobileUrls } from './mobile-server'
import {
  AgentRole,
  CanvasNode,
  DEFAULT_TERMINAL_SIZE,
  TeamForkSpec,
  TeamMeta,
  TerminalNodeData,
  WorkspaceMeta
} from '../shared/model'
import { DEFAULT_ORCH_PRESET, PRESETS } from './presets'
import { forkTerminal as forkTerminalOp, injectWhenReady } from './fork'
import { AgentRegistry } from './agent-registry'
import { EventLog } from './event-log'
import { isClaudeCommand } from '../shared/claude-fork'
import { claudeSessionFile, claudeSpawnCommand, resolveClaudeSessionId } from './claude-fork'
import { SessionTurnSync } from './session-sync'
import { RoleStore } from './roles'
import { TeamStore, forkTeam } from './teams'
import { GitInfoCache, addWorktree } from './git'
import { buildRoleBootMessage } from '../shared/fork'
import { defaultAttachmentsDir, saveAttachment } from './attachments'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const store = new WorkspaceStore()
const ptys = new PtyManager()
const turns = new TurnTracker(summarizeTurn, new TurnStore())
const sessionSync = new SessionTurnSync(turns)
const routines = new RoutineScheduler(store, ptys)
const voice = new VoiceEngine()
const roles = new RoleStore()
const teams = new TeamStore()
const gitCache = new GitInfoCache()
const agents = new AgentRegistry()
const events = new EventLog()
// Observability: the store's op choke-point feeds the durable event log;
// the log's live stream broadcasts to the renderer (mobile gets the same
// stream over the /api/events SSE, subscribed in mobile-api).
store.on('op', (e) => events.append(e))
events.on('event', (e) => mainWindow?.webContents.send('event:new', e))
let mainWindow: BrowserWindow | null = null

/**
 * Persisted commands from before a preset default changed, upgraded on
 * spawn (e.g. terminals saved as plain `claude` predate bypass-by-default).
 * Custom commands (recruit --command ...) never match and pass through.
 */
const LEGACY_COMMANDS: Record<string, string> = {
  claude: 'claude --permission-mode bypassPermissions'
}

/**
 * Record a spawn in the durable agent registry (~/.cookrew/agents.json) and
 * arm exit-deactivation. Detaches (workspace switch, app quit) are NOT exits:
 * the tmux session keeps running, so wasDisposed exits leave the entry active.
 */
function recordSpawn(terminalId: string, session: PtySession): void {
  const hit = store.nodeAcrossWorkspaces(terminalId)
  if (!hit || hit.node.kind !== 'terminal') return
  const meta = store.list().workspaces.find((w) => w.id === hit.workspaceId)
  agents.upsert({
    id: hit.node.id,
    name: hit.node.name,
    preset: hit.node.preset,
    command: hit.node.command,
    role: hit.node.role,
    cwd: hit.node.cwd,
    workspaceId: hit.workspaceId,
    workspaceName: meta?.name ?? hit.workspaceId,
    orch: hit.node.orch
  })
  session.once('exit', () => {
    if (!session.wasDisposed) agents.deactivate(terminalId)
  })
}

/** Spawn (or reuse) a PTY for a terminal node and register turn tracking. */
function spawnTracked(t: {
  id: string
  command: string
  cwd: string
  claudeSessionId?: string | null
}): void {
  const upgraded = LEGACY_COMMANDS[t.command.trim()]
  const command = upgraded ?? t.command
  if (upgraded) store.updateNode(t.id, { command })
  let effective = command
  let boundSessionId: string | null = null
  if (isClaudeCommand(command)) {
    // Bind every Claude terminal to a known session id (adopting one already
    // baked into an older fork command) so session-file features — native
    // fork, resume after a dead tmux session — never guess which session
    // file is this terminal's. tmux reuses live sessions, so the effective
    // command only matters when the terminal actually (re)boots.
    // Resolve against what claude is REALLY running: a stored id whose file is
    // gone (minted for an already-live session tmux reattach never rebooted,
    // or orphaned by a cold reboot) is recovered from turn history rather than
    // resumed blind — otherwise the agent boots an empty conversation. Invalid
    // stored ids (e.g. planted via the unauthenticated node-update endpoint)
    // are dropped inside the resolver before reaching any path/command.
    // NOTE: a still-live tmux session is reattached by `new-session -A`, which
    // ignores this command — so resume only takes on a session that was killed
    // and recreated, never on one that merely detached.
    const sessionId = resolveClaudeSessionId({
      command,
      cwd: t.cwd,
      storedId: t.claudeSessionId,
      turns: turns.history(t.id)
    })
    if (t.claudeSessionId !== sessionId) store.updateNode(t.id, { claudeSessionId: sessionId })
    effective = claudeSpawnCommand(command, t.cwd, sessionId)
    boundSessionId = sessionId
  }
  const session = ptys.spawn({ terminalId: t.id, command: effective, cwd: t.cwd })
  turns.track(session, command.trim().length > 0)
  recordSpawn(t.id, session)
  // Session-bound terminals: the Claude session JSONL is the source of truth
  // for turn records — reconcile now (rebuilds legacy scraped records) and
  // keep reconciling so /rewind truncation and exact prompts flow through.
  if (boundSessionId !== null) {
    sessionSync.watch(t.id, claudeSessionFile(t.cwd, boundSessionId))
  }
}

/**
 * Give the active workspace an orch terminal when it has none. It opens the
 * default orch preset — Claude with bypassed permissions — so the conductor
 * can act without stalling on approvals.
 */
function seedConductorIfEmpty(): void {
  if (store.terminals().length > 0) return
  store.addNode({
    kind: 'terminal',
    id: randomUUID(),
    name: 'Conductor',
    preset: DEFAULT_ORCH_PRESET.name,
    command: DEFAULT_ORCH_PRESET.command,
    cwd: store.state.dir,
    orch: true,
    role: null,
    position: { x: 240, y: 200 },
    size: DEFAULT_TERMINAL_SIZE
  })
}

// ---- workspace operations (shared by IPC and the cookrew CLI) ----
// Switching tears down the outgoing workspace's PTYs and boots the incoming
// canvas's terminals, so only the active workspace holds live processes.

function listWorkspaces(): ReturnType<WorkspaceStore['list']> {
  return store.list()
}

function createWorkspace(name: string, dir: string): WorkspaceMeta {
  const meta = store.createWorkspace(name, dir || store.state.dir)
  store.switchWorkspace(meta.id) // fires 'switch' → PTY teardown/spawn
  seedConductorIfEmpty()
  return meta
}

function switchWorkspace(nameOrId: string): WorkspaceMeta {
  const meta =
    store.list().workspaces.find((w) => w.id === nameOrId) ?? store.metaByName(nameOrId)
  if (!meta) throw new Error(`Workspace '${nameOrId}' not found`)
  return store.switchWorkspace(meta.id)
}

function removeWorkspace(nameOrId: string): ReturnType<WorkspaceStore['list']> {
  const meta =
    store.list().workspaces.find((w) => w.id === nameOrId) ?? store.metaByName(nameOrId)
  if (!meta) throw new Error(`Workspace '${nameOrId}' not found`)
  store.removeWorkspace(meta.id) // switches away first if active (fires 'switch')
  return store.list()
}

// ---- workspace directories + per-terminal cwd (workspace v2) ----

function addWorkspaceDir(id: string, dir: string): ReturnType<WorkspaceStore['list']> {
  return store.addWorkspaceDir(id, dir)
}

function removeWorkspaceDir(id: string, dir: string): ReturnType<WorkspaceStore['list']> {
  return store.removeWorkspaceDir(id, dir)
}

function setPrimaryDir(id: string, dir: string): ReturnType<WorkspaceStore['list']> {
  return store.setPrimaryDir(id, dir)
}

/**
 * Repoint a terminal to another workspace directory and respawn its PTY
 * there — a running process can't change cwd, so the tmux session is killed
 * and recreated in the new dir (turn history survives; it's keyed by id).
 */
function setTerminalCwd(nodeId: string, dir: string): CanvasNode {
  const node = store.setTerminalCwd(nodeId, dir)
  sessionSync.unwatch(nodeId)
  turns.untrack(nodeId)
  ptys.kill(nodeId)
  spawnTracked(node)
  return node
}

// ---- node operations (shared by renderer IPC and the mobile HTTP API) ----

function addNode(node: CanvasNode): CanvasNode {
  const added = store.addNode(node)
  if (added.kind === 'terminal') spawnTracked(added)
  return added
}

function updateNode(id: string, patch: Partial<CanvasNode>): CanvasNode | undefined {
  const existing = store.node(id)
  if (existing?.kind === 'note' && typeof (patch as { content?: string }).content === 'string') {
    const { content, ...rest } = patch as { content: string } & Partial<CanvasNode>
    const written = store.writeNote(id, content)
    return Object.keys(rest).length > 0 ? store.updateNode(id, rest) : written
  }
  return store.updateNode(id, patch)
}

function removeNode(id: string): void {
  sessionSync.unwatch(id)
  turns.untrack(id)
  turns.clearHistory(id)
  ptys.kill(id)
  browserThumbs.delete(id)
  store.removeNode(id)
  agents.deactivate(id)
}

/** Fork an agent from one of its turns — shared by IPC, CLI and mobile. */
function forkTerminal(sourceId: string, turnIndex?: number): TerminalNodeData {
  return forkTerminalOp({ store, ptys, turns, spawnTerminal: spawnTracked }, sourceId, turnIndex)
}

interface CreateTerminalOpts {
  name: string
  preset: string
  position: { x: number; y: number }
  orch: boolean
  /** Boot a fresh agent from a saved role instead of a bare preset. */
  roleName?: string
}

function createTerminal(opts: CreateTerminalOpts): CanvasNode {
  const role = opts.roleName ? roles.get(opts.roleName) : undefined
  if (opts.roleName && !role) throw new Error(`No saved role '${opts.roleName}'`)
  const preset = PRESETS.find((p) => p.name === opts.preset) ?? PRESETS[PRESETS.length - 1]
  const terminal: TerminalNodeData = {
    kind: 'terminal',
    id: randomUUID(),
    name: opts.name || role?.name || preset.name,
    preset: role ? role.preset : preset.name,
    command: role ? role.command : preset.command,
    cwd: store.state.dir,
    orch: opts.orch,
    role: role ? role.name : null,
    position: opts.position,
    size: DEFAULT_TERMINAL_SIZE
  }
  const added = store.addNode(terminal)
  spawnTracked(added as TerminalNodeData)
  if (role) {
    const session = ptys.get(added.id)
    if (session) {
      injectWhenReady(session, buildRoleBootMessage(role.name, role.rolePrompt)).catch((error) =>
        console.error('Role boot injection failed:', error)
      )
    }
  }
  return added
}

// ---- team fork / save + roles (spec: team-fork-roles v1, Forge lane) ----

async function teamFork(spec: TeamForkSpec): Promise<WorkspaceMeta> {
  const meta = await teamForkInner(spec)
  store.recordEvent('team.forked', meta.id, meta.name)
  return meta
}

function teamForkInner(spec: TeamForkSpec): Promise<WorkspaceMeta> {
  return forkTeam(
    {
      store,
      turns,
      roles,
      teams,
      ptys,
      switchWorkspace: (id) => void switchWorkspace(id),
      git: { gitInfo: (dir) => gitCache.info(dir), addWorktree },
      worktreeRoot: path.join(homedir(), '.cookrew', 'worktrees')
    },
    spec
  )
}

function teamSaveTracked(name?: string): TeamMeta {
  const meta = teamSaveInner(name)
  store.recordEvent('team.saved', meta.name, meta.name, `${meta.terminalCount} agents`)
  return meta
}

function teamSaveInner(name?: string): TeamMeta {
  return teams.save(store.state, (id) => turns.history(id), name)
}

function roleSaveTracked(input: { nodeId: string; name: string; rolePrompt: string }): AgentRole {
  const role = roleSaveInner(input)
  store.recordEvent('role.saved', role.name, role.name, role.preset)
  return role
}

function roleSaveInner(input: { nodeId: string; name: string; rolePrompt: string }): AgentRole {
  const node = store.node(input.nodeId)
  if (!node || node.kind !== 'terminal') throw new Error('Role source is not a terminal node')
  return roles.save(node, input.name, input.rolePrompt)
}

/**
 * Debug input injection: drives the renderer through Electron's real input
 * pipeline (same hit-testing and event handlers as user clicks), so UI flows
 * can be verified headlessly alongside `app-shot`.
 */
async function injectInput(args: string[]): Promise<string> {
  if (!mainWindow) throw new Error('No window')
  const wc = mainWindow.webContents
  const [sub, ...rest] = args
  if (sub === 'click') {
    const x = parseInt(rest[0], 10)
    const y = parseInt(rest[1], 10)
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    return `Clicked ${x},${y}`
  }
  if (sub === 'dblclick') {
    const x = parseInt(rest[0], 10)
    const y = parseInt(rest[1], 10)
    for (const clickCount of [1, 2]) {
      wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount })
      wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount })
    }
    return `Double-clicked ${x},${y}`
  }
  if (sub === 'type') {
    for (const char of rest.join(' ')) {
      wc.sendInputEvent({ type: 'char', keyCode: char })
      await new Promise((resolve) => setTimeout(resolve, 15))
    }
    return `Typed ${rest.join(' ').length} chars`
  }
  if (sub === 'key') {
    const keyCode = rest[0]
    // Optional modifiers as a 2nd arg: "meta", "meta+shift", etc.
    const modifiers = rest[1]
      ? (rest[1].split(/[+,]/) as Array<'shift' | 'control' | 'meta' | 'alt'>)
      : undefined
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    return `Pressed ${keyCode}${rest[1] ? ` +${rest[1]}` : ''}`
  }
  throw new Error('Usage: cookrew ui click X Y | dblclick X Y | type "text" | key Enter')
}

async function captureWindow(): Promise<string> {
  if (!mainWindow) throw new Error('No window')
  const image = await mainWindow.webContents.capturePage()
  const file = path.join(ptys.runtimeDir, `app-shot-${Date.now()}.png`)
  await import('node:fs/promises').then((fs) => fs.writeFile(file, image.toPNG()))
  return file
}

/** Pending browser command requests forwarded to the renderer. */
const browserWaiters = new Map<string, { resolve: (v: string) => void; reject: (e: Error) => void }>()

/**
 * Latest browser thumbnails, pushed from the renderer's capturePage() loop.
 * Kept here (not just in renderer state) so the mobile companion can serve
 * them as images to the phone's canvas cards.
 */
const browserThumbs = new Map<string, Buffer>()

function browserCommand(args: string[], terminalId: string): Promise<string> {
  if (!mainWindow) return Promise.reject(new Error('No window'))
  const id = randomUUID()
  const promise = new Promise<string>((resolve, reject) => {
    browserWaiters.set(id, { resolve, reject })
    setTimeout(() => {
      if (browserWaiters.has(id)) {
        browserWaiters.delete(id)
        reject(new Error('Browser command timed out'))
      }
    }, 30000)
  })
  mainWindow.webContents.send('browser:command', { id, args, terminalId })
  return promise
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Cookrew',
    backgroundColor: '#FAF8F4',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(dirname, '../preload/index.cjs'),
      webviewTag: true
    }
  })

  // ⌘W is layered: the renderer closes the topmost closeable thing first (a
  // browser tab, then a zoomed-in overlay) and only quits when nothing is left.
  // ⌘Q always quits. Handled here (not via a menu) so both fire with focus
  // inside an xterm terminal or a browser webview, which have their own
  // webContents — the event is always routed to the main renderer to decide.
  const appShortcuts = (
    event: Electron.Event,
    input: Electron.Input
  ): void => {
    if (input.type !== 'keyDown' || !input.meta) return
    const key = input.key.toLowerCase()
    if (key === 'w') {
      event.preventDefault()
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('app:cmd-w')
      }
    } else if (key === 'q') {
      event.preventDefault()
      app.quit()
    }
  }
  mainWindow.webContents.on('before-input-event', appShortcuts)

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(path.join(dirname, '../renderer/index.html'))
  }
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // Browser webviews: window.open / target=_blank must become a tab in the
  // same browser, never a detached native window. The renderer maps the
  // webContents id back to the owning browser and appends a tab.
  mainWindow.webContents.on('did-attach-webview', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url) && mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('browser:open-tab', { webContentsId: contents.id, url })
      }
      return { action: 'deny' }
    })
    // A browser webview has its own webContents, so ⌘W with focus inside a
    // browser wouldn't reach the main window without this.
    contents.on('before-input-event', appShortcuts)
  })
  mainWindow.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`)
  })
}

app.whenReady().then(() => {
  // Dock icon must be set at runtime in dev; packaged builds also bundle
  // resources/icon.icns via the packager config when one is added.
  if (process.platform === 'darwin' && app.dock) {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, 'icon.png')
      : path.join(dirname, '../../resources/icon.png')
    try {
      app.dock.setIcon(iconPath)
    } catch (error) {
      console.error('Dock icon failed to load:', error)
    }
  }
  // Ship the CLI next to the socket so PTYs get it on PATH.
  const cliSource = app.isPackaged
    ? path.join(process.resourcesPath, 'cli', 'cookrew.mjs')
    : path.join(dirname, '../../cli/cookrew.mjs')
  try {
    ptys.installCli(cliSource)
  } catch (error) {
    console.error('CLI install failed:', error)
  }
  // Push the current tmux config to sessions that survived a previous run,
  // so reattached terminals show the (possibly updated) status bar.
  ptys.reloadTmuxConfig()

  startSocketServer({
    store,
    ptys,
    spawnTerminal: spawnTracked,
    agents,
    turns,
    forkTerminal,
    routines,
    browserCommand,
    notify: showNotification,
    captureWindow,
    injectInput,
    voice,
    mobileUrls,
    listWorkspaces,
    createWorkspace,
    switchWorkspace,
    removeWorkspace,
    addWorkspaceDir,
    removeWorkspaceDir,
    setPrimaryDir,
    setTerminalCwd,
    gitInfo: (dir: string) => gitCache.info(dir),
    teamFork,
    teamSave: teamSaveTracked,
    teamList: () => teams.list(),
    roleSave: roleSaveTracked,
    roleList: () => roles.list(),
    roleDelete: (name: string) => roles.delete(name)
  })
  routines.start()

  const mobileClientPath = app.isPackaged
    ? path.join(process.resourcesPath, 'mobile', 'client.html')
    : path.join(dirname, '../../mobile/client.html')
  startMobileServer({
    store,
    events,
    agents,
    ptys,
    voice,
    turns,
    presets: PRESETS,
    ops: {
      addNode,
      updateNode,
      removeNode,
      createTerminal,
      forkTerminal,
      listWorkspaces,
      createWorkspace,
      switchWorkspace,
      renameWorkspace: (id, name) => {
        store.renameWorkspace(id, name)
        return store.list()
      },
      removeWorkspace,
      addWorkspaceDir,
      removeWorkspaceDir,
      setPrimaryDir,
      setTerminalCwd,
      gitInfo: (dir: string) => gitCache.info(dir),
      teamFork,
      teamSave: teamSaveTracked,
      teamList: () => teams.list(),
      roleSave: roleSaveTracked,
      roleList: () => roles.list(),
      roleDelete: (name: string) => roles.delete(name)
    },
    saveAttachment: (name, data) => saveAttachment(defaultAttachmentsDir(), name, data),
    browserThumb: (id) => browserThumbs.get(id),
    clientHtmlPath: mobileClientPath,
    // Built renderer bundle — served to phones so mobile gets the full
    // desktop canvas UI (missing until `npm run build` in dev checkouts).
    rendererDir: path.join(dirname, '../renderer')
  })
  registerIpc()
  createWindow()

  // First launch: seed the active workspace with a bypass-permission orch.
  seedConductorIfEmpty()

  // Boot PTYs for terminals restored from the saved workspace.
  for (const t of store.terminals()) {
    spawnTracked(t)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('before-quit', () => {
  store.flush()
  events.flush()
  sessionSync.dispose()
  turns.flushHistories()
  turns.disposeAll()
  ptys.disposeAll()
})

function showNotification(message: string): void {
  new Notification({ title: 'Cookrew', body: message }).show()
}

function broadcast(): void {
  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('workspace:state', store.state)
  }
}

function registerIpc(): void {
  store.on('change', broadcast)

  // On workspace switch, tear down the outgoing PTYs and boot the incoming
  // canvas's terminals. Only the active workspace holds live processes.
  store.on('switch', ({ previousTerminalIds }: { previousTerminalIds: string[] }) => {
    // Detach (not kill): the outgoing workspace's tmux sessions stay alive so
    // switching back reattaches them with their agents and scrollback intact.
    for (const tid of previousTerminalIds) {
      sessionSync.unwatch(tid)
      turns.untrack(tid)
      ptys.detach(tid)
    }
    for (const t of store.terminals()) spawnTracked(t)
  })

  // Push the workspace list to the renderer whenever it changes.
  store.on('workspaces', (list) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('workspace:list', list)
    }
  })

  // Renderer resolved a ⌘W to "nothing left to close" → quit.
  ipcMain.on('app:quit', () => app.quit())

  ipcMain.handle('workspace:list', () => store.list())
  ipcMain.handle('workspace:create', (_e, name: string, dir: string) => createWorkspace(name, dir))
  ipcMain.handle('workspace:switch', (_e, id: string) => {
    switchWorkspace(id)
    return store.list()
  })
  ipcMain.handle('workspace:rename', (_e, id: string, name: string) => {
    store.renameWorkspace(id, name)
    return store.list()
  })
  // Workspace v2: remove + multi-directory + per-terminal cwd + git.
  ipcMain.handle('workspace:remove', (_e, id: string) => removeWorkspace(id))
  ipcMain.handle('workspace:dir:add', (_e, id: string, dir: string) => addWorkspaceDir(id, dir))
  ipcMain.handle('workspace:dir:remove', (_e, id: string, dir: string) =>
    removeWorkspaceDir(id, dir)
  )
  ipcMain.handle('workspace:dir:setPrimary', (_e, id: string, dir: string) =>
    setPrimaryDir(id, dir)
  )
  ipcMain.handle('terminal:setCwd', (_e, nodeId: string, dir: string) => setTerminalCwd(nodeId, dir))
  ipcMain.handle('git:info', (_e, dir: string) => gitCache.info(dir))
  ipcMain.handle('dir:pick', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // Turn/summary activity for the canvas cards.
  turns.on('activity', (activity) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('terminal:activity', activity)
    }
  })
  ipcMain.handle('activity:list', () => turns.list())

  // Acknowledge-on-view: the renderer reports "user is viewing this
  // terminal's result" (overlay mount / phone popout) — fire-and-forget.
  ipcMain.on('turn:seen', (_e, terminalId: string) => turns.seen(terminalId))

  // Turn history + fork-from-turn for the canvas cards.
  ipcMain.handle('turn:history', (_e, terminalId: string) => turns.history(terminalId))
  // Observability event log: filtered history + counts + agent roster.
  ipcMain.handle('events:query', (_e, query) => events.query(query ?? {}))
  ipcMain.handle('events:count', (_e, query) => events.count(query ?? {}))
  ipcMain.handle('agents:list', () => agents.list())
  ipcMain.handle('terminal:fork', (_e, sourceId: string, turnIndex?: number) =>
    forkTerminal(sourceId, turnIndex)
  )

  ipcMain.handle('workspace:get', () => store.state)

  ipcMain.handle('node:add', (_e, node: CanvasNode) => addNode(node))
  ipcMain.handle('node:update', (_e, id: string, patch: Partial<CanvasNode>) =>
    updateNode(id, patch)
  )
  ipcMain.handle('node:remove', (_e, id: string) => removeNode(id))

  ipcMain.handle('node:connect', (_e, aId: string, bId: string) => store.connect(aId, bId))
  ipcMain.handle('node:disconnect', (_e, connId: string) => store.disconnect(connId))

  ipcMain.handle('preset:list', () => PRESETS)

  ipcMain.handle('terminal:create', (_e, opts: CreateTerminalOpts) => createTerminal(opts))

  // Team fork / team save / roles (contract in note team-fork-roles-spec-v1).
  ipcMain.handle('team:fork', (_e, spec: TeamForkSpec) => teamFork(spec))
  ipcMain.handle('team:save', (_e, name?: string) => teamSaveTracked(name))
  ipcMain.handle('team:list', () => teams.list())
  ipcMain.handle('role:save', (_e, input: { nodeId: string; name: string; rolePrompt: string }) =>
    roleSaveTracked(input)
  )
  ipcMain.handle('role:list', () => roles.list())
  ipcMain.handle('role:delete', (_e, name: string) => roles.delete(name))

  // 📎 attach: native multi-file picker for the desktop renderer. Dropped
  // files never come through here — the preload resolves their paths locally.
  ipcMain.handle('attach:pick', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections']
    })
    return result.canceled ? [] : result.filePaths
  })

  // 📎 attach: save raw bytes (a pasted clipboard image) and return its path.
  // Same store + 20MB cap + name sanitize as phone uploads.
  ipcMain.handle('attach:save', (_e, name: string, bytes: Uint8Array) =>
    saveAttachment(defaultAttachmentsDir(), name, Buffer.from(bytes))
  )

  // Terminal stream bridging renderer xterm <-> PTY
  ipcMain.on('pty:input', (_e, terminalId: string, data: string) => {
    ptys.get(terminalId)?.write(data)
  })
  ipcMain.on('pty:resize', (_e, terminalId: string, cols: number, rows: number) => {
    ptys.get(terminalId)?.resize(cols, rows)
  })
  // Turn navigation: scroll the tmux view to a past ask (null returns live).
  ipcMain.on('pty:jump', (_e, terminalId: string, text: string | null) => {
    const session = ptys.get(terminalId)
    if (!session) return
    if (text) session.jumpToText(text)
    else session.exitCopyMode()
  })
  // One forwarder per terminal: React StrictMode double-mounts (and HMR
  // remounts) call attach repeatedly, and stacked listeners would duplicate
  // every byte of output in the renderer.
  const forwarders = new Map<string, (data: string) => void>()
  ipcMain.handle('pty:attach', (event, terminalId: string) => {
    const session = ptys.get(terminalId)
    if (!session) return false
    const previous = forwarders.get(terminalId)
    if (previous) session.removeListener('data', previous)
    const listener = (data: string): void => {
      // The window can be closed or reloaded while the PTY keeps emitting;
      // sending to a destroyed webContents throws "Object has been destroyed".
      if (event.sender.isDestroyed()) {
        session.removeListener('data', listener)
        forwarders.delete(terminalId)
        return
      }
      event.sender.send(`pty:data:${terminalId}`, data)
    }
    forwarders.set(terminalId, listener)
    session.on('data', listener)
    // Clear the fresh renderer terminal before replaying: the replay is
    // plain text and cannot reconstruct a TUI's screen state — the popout
    // follows up with a resize kick to force a authoritative repaint.
    event.sender.send(
      `pty:data:${terminalId}`,
      '\x1b[2J\x1b[3J\x1b[H' + session.viewportText() + '\r\n'
    )
    return true
  })
  // The popout detaches on close; without this the forwarder would keep
  // serializing every output chunk to a channel nobody listens on.
  ipcMain.on('pty:detach', (_e, terminalId: string) => {
    const listener = forwarders.get(terminalId)
    const session = ptys.get(terminalId)
    if (listener && session) session.removeListener('data', listener)
    forwarders.delete(terminalId)
  })

  // Thumbnail frames from the renderer's browser capture loop (data URLs).
  ipcMain.on('browser:thumb', (_e, browserId: string, dataUrl: string) => {
    const base64 = dataUrl.split(',')[1]
    if (base64) browserThumbs.set(browserId, Buffer.from(base64, 'base64'))
  })

  // Browser command responses coming back from the renderer
  ipcMain.on('browser:result', (_e, id: string, ok: boolean, output: string) => {
    const waiter = browserWaiters.get(id)
    if (!waiter) return
    browserWaiters.delete(id)
    if (ok) waiter.resolve(output)
    else waiter.reject(new Error(output))
  })
}
