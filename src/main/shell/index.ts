/**
 * THE ELECTRON SHELL (D0 step 3 of the move off Electron).
 *
 * Electron reduced to the window. Everything the app does runs in cookrewd,
 * the main process as a headless daemon (src/main/daemon), which this shell
 * launches and holds by the owner link: one end of a socket pair passed as fd
 * 3 (owner-link.ts). The renderer and the preload are the app's own and do not
 * change: every channel the daemon serves gets a forwarder (bridge.ts), every
 * event the daemon's owner window sends is relayed to this window, and this
 * window's lifecycle (focus, load, reload, a crashed renderer) is told to the
 * daemon so main's own listeners still run.
 *
 * THE OWNER BOUNDARY LIVES HERE NOW. The daemon treats the link as the owner,
 * so a call crosses only from this window's top frame showing the owner page
 * (bridge.ts · isOwnerCall), and the window never follows a page elsewhere
 * (will-navigate), as the old main kept it.
 *
 * What stays in the shell, because it needs the real window or a person: the
 * folder and file pickers, quitting, ⌘W/⌘Q (in browser cards too), and a
 * browser card's popups becoming tabs.
 *
 * KNOWN GAPS (D0 step 4): browser-card streaming (a MessagePort cannot cross
 * the pipe; the shell will bridge the daemon's WebSocket), window captures
 * (workspace:snap), desktop notifications, deep links, the tray, the updater.
 */
import { app, BrowserWindow, dialog, ipcMain, shell, type Input, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Socket } from 'node:net'
import { createOwnerClient, type OwnerClient } from '../daemon/owner-client'
import { isOwnerPage } from '../owner-grant'
import { registryArgument } from '../../shared/machine-words'
import { registryOrigin } from '../registry-origin'
import { FORWARDED_CONTENTS_EVENTS, FORWARDED_WINDOW_EVENTS, HeldEvents, isOwnerCall, registerBridge, type CallerEvent } from './bridge'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const DAEMON_ENTRY = path.join(dirname, '../daemon/index.js')
/** The daemon's meta request for its channel list (electron-shim.ts · OWNER_CHANNELS). */
const OWNER_CHANNELS = '$channels'
/** How long a quitting shell waits for the daemon's own shutdown (asks cancelled, browsers closed). */
const DAEMON_DRAIN_MS = 15_000

let mainWindow: BrowserWindow | null = null
let daemon: ChildProcess | null = null
let quitting = false
let daemonExited = false

const ownerPageUrl = (): string => process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(path.join(dirname, '../renderer/index.html')).href

/** Channels answered here rather than by the daemon: they need this window or a person. */
const LOCAL_HANDLERS: Record<string, (...args: unknown[]) => unknown> = {
  'dir:pick': async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  },
  'attach:pick': async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, { title: 'Attach files', properties: ['openFile', 'multiSelections'] })
    return result.canceled ? [] : result.filePaths
  }
}

/** Sends handled here; `browser-stream:open` is a known gap (logged). */
const LOCAL_SENDS: Record<string, (...args: unknown[]) => void> = {
  'app:quit': () => app.quit(),
  'browser-stream:open': () => console.error('[cookrew shell] browser-card streaming is not bridged yet (D0 step 4)')
}

/** Let the daemon finish its own shutdown drain (within a limit), then run `then`. */
function afterDaemon(then: () => void): void {
  const child = daemon
  if (child === null || child.exitCode !== null || child.signalCode !== null) {
    then()
    return
  }
  child.once('exit', then)
  setTimeout(() => {
    console.error(`[cookrew shell] the daemon did not finish within ${DAEMON_DRAIN_MS} ms; stopping it`)
    child.kill('SIGKILL')
    then()
  }, DAEMON_DRAIN_MS).unref()
  child.kill('SIGTERM')
}

/**
 * The daemon went away, or its line did (or it never came). One place says
 * so, once, unless the app is quitting; a daemon still alive behind a closed
 * line is let finish its drain before the app goes.
 */
function daemonGone(reason: string): void {
  if (daemonExited) return
  daemonExited = true
  if (quitting) return
  quitting = true
  console.error(`[cookrew shell] ${reason}; the app cannot run without it`)
  dialog.showErrorBox('Cookrew stopped', `Cookrew's background process ${reason}. Start Cookrew again.`)
  afterDaemon(() => app.exit(1))
}

/**
 * The daemon, with fd 3 as the owner link and stdin as the leash (it exits
 * when this shell goes). Its userData is beside the shell's own, never the
 * same folder: two processes on one SingletonLock refuse each other.
 */
function launchDaemon(): ChildProcess {
  const userData = path.join(app.getPath('userData'), 'daemon')
  mkdirSync(userData, { recursive: true })
  const child = spawn(process.execPath, [DAEMON_ENTRY], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', COOKREWD: '1', COOKREWD_OWNER_FD: '3', COOKREWD_PARENT_PIPE: '1', COOKREWD_USER_DATA: userData },
    stdio: ['pipe', 'inherit', 'inherit', 'pipe']
  })
  child.on('exit', (code, signal) => daemonGone(code === 78 ? 'refused to start (exit 78: see its log)' : `exited (${code ?? signal})`))
  child.on('error', (error) => daemonGone(`did not start: ${error.message}`))
  return child
}

/** ⌘W is the renderer's to decide (it closes the topmost closeable thing first); ⌘Q quits. */
function appShortcuts(owner: () => BrowserWindow | null) {
  return (event: Electron.Event, input: Input): void => {
    if (input.type !== 'keyDown' || !input.meta) return
    const key = input.key.toLowerCase()
    if (key === 'w') {
      event.preventDefault()
      const win = owner()
      if (win && !win.webContents.isDestroyed()) win.webContents.send('app:cmd-w')
    } else if (key === 'q') {
      event.preventDefault()
      app.quit()
    }
  }
}

/** The real window's lifecycle, told to the daemon (bridge.ts · FORWARDED_*). */
function forwardLifecycle(win: BrowserWindow, client: OwnerClient): void {
  for (const name of FORWARDED_WINDOW_EVENTS) {
    win.on(name as 'focus', () => client.windowEvent('window', name, [{}]))
  }
  for (const name of FORWARDED_CONTENTS_EVENTS) {
    win.webContents.on(name as 'did-finish-load', (...args: unknown[]) => {
      // did-start-navigation's first argument is its details (board-hold.ts reads
      // isMainFrame / isSameDocument); the others' first argument is the event.
      const first = args[0] as { isMainFrame?: unknown; isSameDocument?: unknown; url?: unknown } | undefined
      const head =
        name === 'did-start-navigation'
          ? { isMainFrame: first?.isMainFrame === true, isSameDocument: first?.isSameDocument === true, url: typeof first?.url === 'string' ? first.url : '' }
          : {}
      client.windowEvent('contents', name, [head])
    })
  }
}

function createWindow(client: OwnerClient, events: HeldEvents): BrowserWindow {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    title: 'Cookrew',
    backgroundColor: '#FAF8F4',
    titleBarStyle: 'hiddenInset',
    // A QA run drives the window over CDP without putting it on the owner's screen.
    show: process.env.COOKREW_SHELL_HIDDEN !== '1',
    webPreferences: {
      preload: path.join(dirname, '../preload/index.cjs'),
      webviewTag: true,
      additionalArguments: [registryArgument(registryOrigin())]
    }
  })
  const shortcuts = appShortcuts(() => mainWindow)
  win.webContents.on('before-input-event', shortcuts)
  // The window holds the owner's bridge: a page only ever leaves it for the
  // browser. Followed in here it would inherit the preload, and its calls
  // would be refused anyway (bridge.ts) but must never get the chance.
  win.webContents.on('will-navigate', (event, url) => {
    if (isOwnerPage(url, ownerPageUrl())) return
    event.preventDefault()
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // Browser webviews: window.open / target=_blank must become a tab in the
  // same browser, never a detached native window; ⌘W inside one reaches us too.
  win.webContents.on('did-attach-webview', (_event, contents: WebContents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url) && mainWindow && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send('browser:open-tab', { webContentsId: contents.id, url })
      }
      return { action: 'deny' }
    })
    contents.on('before-input-event', shortcuts)
  })
  win.webContents.on('console-message', (_event, _level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`)
  })
  // The daemon's events reach the page once it has loaded (held until then).
  win.webContents.once('did-finish-load', () => {
    const dropped = events.open((channel, args) => {
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, ...args)
    })
    if (dropped > 0) console.error(`[cookrew shell] ${dropped} early event(s) were dropped before the page loaded`)
  })
  forwardLifecycle(win, client)
  win.on('closed', () => {
    mainWindow = null
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(dirname, '../renderer/index.html'))
  return win
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(async () => {
    daemon = launchDaemon()
    const pipe = daemon.stdio[3] as Socket
    const client = createOwnerClient(pipe, pipe)
    // Subscribed before anything is asked: the daemon hands over its early events as soon as it connects.
    const events = new HeldEvents()
    client.onEvent((channel, args) => events.push(channel, args))
    void client.closed.then(() => daemonGone('closed its line to the app'))
    let channels: { handle: string[]; on: string[] }
    try {
      const listed = (await client.invoke(OWNER_CHANNELS)) as { handle?: unknown; on?: unknown }
      const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((c): c is string => typeof c === 'string') : [])
      channels = { handle: strings(listed.handle), on: strings(listed.on) }
    } catch (error) {
      daemonGone(`did not come up (${error instanceof Error ? error.message : String(error)})`)
      return
    }
    const counts = registerBridge({
      ipc: ipcMain as unknown as Parameters<typeof registerBridge>[0]['ipc'],
      client,
      channels,
      localHandlers: LOCAL_HANDLERS,
      localSends: LOCAL_SENDS,
      isOwner: (event: CallerEvent) => isOwnerCall(event, mainWindow?.webContents, ownerPageUrl())
    })
    console.error(`[cookrew shell] bridged ${counts.handle} handled and ${counts.on} sent channels to the daemon`)
    mainWindow = createWindow(client, events)
  })

  app.on('window-all-closed', () => app.quit())

  // The old main held the quit until its own drain finished (asks cancelled,
  // herdr calls ended, browsers shut). The daemon runs that drain now, so the
  // shell waits for the daemon to exit, within a limit, and then goes.
  app.on('before-quit', (event) => {
    if (daemonExited || daemon === null) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    afterDaemon(() => app.exit(0))
  })
}
