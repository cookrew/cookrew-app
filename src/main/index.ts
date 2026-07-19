import { app, BrowserWindow, ipcMain, Notification } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { WorkspaceStore } from './store'
import { PtyManager } from './pty'
import { TurnTracker } from './turn-tracker'
import { startSocketServer } from './socket-server'
import { RoutineScheduler } from './routines'
import { VoiceEngine } from './voice'
import { startMobileServer, mobileUrls } from './mobile-server'
import { CanvasNode, DEFAULT_TERMINAL_SIZE, TerminalNodeData, WorkspaceMeta } from '../shared/model'
import { PRESETS } from './presets'

const dirname = path.dirname(fileURLToPath(import.meta.url))

const store = new WorkspaceStore()
const ptys = new PtyManager()
const turns = new TurnTracker()
const routines = new RoutineScheduler(store, ptys)
const voice = new VoiceEngine()
let mainWindow: BrowserWindow | null = null

/**
 * Persisted commands from before a preset default changed, upgraded on
 * spawn (e.g. terminals saved as plain `claude` predate bypass-by-default).
 * Custom commands (recruit --command ...) never match and pass through.
 */
const LEGACY_COMMANDS: Record<string, string> = {
  claude: 'claude --permission-mode bypassPermissions'
}

/** Spawn (or reuse) a PTY for a terminal node and register turn tracking. */
function spawnTracked(t: { id: string; command: string; cwd: string }): void {
  const upgraded = LEGACY_COMMANDS[t.command.trim()]
  const command = upgraded ?? t.command
  if (upgraded) store.updateNode(t.id, { command })
  const session = ptys.spawn({ terminalId: t.id, command, cwd: t.cwd })
  turns.track(session, command.trim().length > 0)
}

/** Give the active workspace a Orch shell terminal when it has none. */
function seedConductorIfEmpty(): void {
  if (store.terminals().length > 0) return
  store.addNode({
    kind: 'terminal',
    id: randomUUID(),
    name: 'Conductor',
    preset: 'Shell',
    command: '',
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
  turns.untrack(id)
  ptys.kill(id)
  browserThumbs.delete(id)
  store.removeNode(id)
}

interface CreateTerminalOpts {
  name: string
  preset: string
  position: { x: number; y: number }
  orch: boolean
}

function createTerminal(opts: CreateTerminalOpts): CanvasNode {
  const preset = PRESETS.find((p) => p.name === opts.preset) ?? PRESETS[PRESETS.length - 1]
  const terminal: TerminalNodeData = {
    kind: 'terminal',
    id: randomUUID(),
    name: opts.name || preset.name,
    preset: preset.name,
    command: preset.command,
    cwd: store.state.dir,
    orch: opts.orch,
    role: null,
    position: opts.position,
    size: DEFAULT_TERMINAL_SIZE
  }
  const added = store.addNode(terminal)
  spawnTracked(added as TerminalNodeData)
  return added
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
    routines,
    browserCommand,
    notify: showNotification,
    captureWindow,
    injectInput,
    voice,
    mobileUrls,
    listWorkspaces,
    createWorkspace,
    switchWorkspace
  })
  routines.start()

  const mobileClientPath = app.isPackaged
    ? path.join(process.resourcesPath, 'mobile', 'client.html')
    : path.join(dirname, '../../mobile/client.html')
  startMobileServer({
    store,
    ptys,
    voice,
    turns,
    presets: PRESETS,
    ops: {
      addNode,
      updateNode,
      removeNode,
      createTerminal,
      listWorkspaces,
      createWorkspace,
      switchWorkspace,
      renameWorkspace: (id, name) => {
        store.renameWorkspace(id, name)
        return store.list()
      }
    },
    browserThumb: (id) => browserThumbs.get(id),
    clientHtmlPath: mobileClientPath,
    // Built renderer bundle — served to phones so mobile gets the full
    // desktop canvas UI (missing until `npm run build` in dev checkouts).
    rendererDir: path.join(dirname, '../renderer')
  })
  registerIpc()
  createWindow()

  // First launch: seed the active workspace with a Orch shell terminal.
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

  // Turn/summary activity for the canvas cards.
  turns.on('activity', (activity) => {
    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('terminal:activity', activity)
    }
  })
  ipcMain.handle('activity:list', () => turns.list())

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

  // Terminal stream bridging renderer xterm <-> PTY
  ipcMain.on('pty:input', (_e, terminalId: string, data: string) => {
    ptys.get(terminalId)?.write(data)
  })
  ipcMain.on('pty:resize', (_e, terminalId: string, cols: number, rows: number) => {
    ptys.get(terminalId)?.resize(cols, rows)
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
