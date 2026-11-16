/**
 * THE ELECTRON SHELL (D0 step 3 of the move off Electron).
 *
 * Electron reduced to the window. Everything the app does runs in cookrewd,
 * the main process as a headless daemon (src/main/daemon), which this shell
 * launches and holds by the owner link: one end of a socket pair passed as fd
 * 3 (owner-link.ts). The renderer and the preload are the app's own and do not
 * change: every channel the daemon serves gets a forwarder here, and every
 * event the daemon's owner window sends is relayed to this window.
 *
 * What stays HERE, because it needs the real window or a person at the screen:
 * the folder and file pickers, quitting, and the ⌘W/⌘Q keys.
 *
 * KNOWN GAPS (D0 step 4): browser-card streaming (a MessagePort cannot cross
 * the pipe; the shell will bridge the daemon's WebSocket), window captures
 * (workspace:snap), desktop notifications, deep links, the tray and the
 * updater. Each is logged when used.
 */
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Socket } from 'node:net'
import { createOwnerClient, type OwnerClient } from '../daemon/owner-client'
import { registryArgument } from '../../shared/machine-words'
import { registryOrigin } from '../registry-origin'

const dirname = path.dirname(fileURLToPath(import.meta.url))
const DAEMON_ENTRY = path.join(dirname, '../daemon/index.js')
/** The daemon's meta request for its channel list (electron-shim.ts · OWNER_CHANNELS). */
const OWNER_CHANNELS = '$channels'

let mainWindow: BrowserWindow | null = null
let daemon: ChildProcess | null = null
let quitting = false

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

/** Sends handled here; `browser-stream:open` is a known gap (the renderer's view waits; logged). */
const LOCAL_SENDS: Record<string, (...args: unknown[]) => void> = {
  'app:quit': () => app.quit(),
  'browser-stream:open': () => console.error('[cookrew shell] browser-card streaming is not bridged yet (D0 step 4)')
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
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      COOKREWD: '1',
      COOKREWD_OWNER_FD: '3',
      COOKREWD_PARENT_PIPE: '1',
      COOKREWD_USER_DATA: userData
    },
    stdio: ['pipe', 'inherit', 'inherit', 'pipe']
  })
  child.on('exit', (code, signal) => {
    if (quitting) return
    console.error(`[cookrew shell] the daemon exited (${code ?? signal}); the app cannot run without it`)
    dialog.showErrorBox('Cookrew stopped', `Cookrew's background process exited (${code ?? signal}). Start Cookrew again.`)
    app.quit()
  })
  child.on('error', (error) => {
    console.error('[cookrew shell] the daemon did not start:', error)
    dialog.showErrorBox('Cookrew could not start', String(error))
    app.quit()
  })
  return child
}

/** One forwarder per channel the daemon serves, local ones first. */
async function bridge(client: OwnerClient): Promise<{ handle: number; on: number }> {
  const channels = (await client.invoke(OWNER_CHANNELS)) as { handle?: unknown; on?: unknown }
  const handle = Array.isArray(channels.handle) ? channels.handle.filter((c): c is string => typeof c === 'string') : []
  const on = Array.isArray(channels.on) ? channels.on.filter((c): c is string => typeof c === 'string') : []
  for (const channel of new Set([...handle, ...Object.keys(LOCAL_HANDLERS)])) {
    const local = LOCAL_HANDLERS[channel]
    ipcMain.handle(channel, local ? (_event, ...args) => local(...args) : (_event, ...args) => client.invoke(channel, args))
  }
  for (const channel of new Set([...on, ...Object.keys(LOCAL_SENDS)])) {
    const local = LOCAL_SENDS[channel]
    ipcMain.on(channel, local ? (_event, ...args) => local(...args) : (_event, ...args) => client.send(channel, args))
  }
  client.onEvent((channel, args) => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) mainWindow.webContents.send(channel, ...args)
  })
  return { handle: handle.length, on: on.length }
}

function createWindow(): BrowserWindow {
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
  // ⌘W is the renderer's to decide (it closes the topmost closeable thing first); ⌘Q quits.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.meta) return
    const key = input.key.toLowerCase()
    if (key === 'w') {
      event.preventDefault()
      win.webContents.send('app:cmd-w')
    } else if (key === 'q') {
      event.preventDefault()
      app.quit()
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(path.join(dirname, '../renderer/index.html'))
  return win
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  void app.whenReady().then(async () => {
    daemon = launchDaemon()
    const pipe = daemon.stdio[3] as Socket
    const client = createOwnerClient(pipe, pipe)
    void client.closed.then(() => {
      if (!quitting) app.quit()
    })
    try {
      const counts = await bridge(client)
      console.error(`[cookrew shell] bridged ${counts.handle} handled and ${counts.on} sent channels to the daemon`)
    } catch (error) {
      console.error('[cookrew shell] the daemon did not answer its channel list:', error)
      dialog.showErrorBox('Cookrew could not start', `The background process did not come up: ${String(error)}`)
      app.quit()
      return
    }
    mainWindow = createWindow()
  })

  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    quitting = true
    daemon?.kill('SIGTERM')
  })
}
