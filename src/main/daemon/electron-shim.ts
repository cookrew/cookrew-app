/**
 * THE `electron` MODULE FOR A MAIN PROCESS WITH NO WINDOW (cookrewd, D0).
 *
 * scripts/daemon-build.mjs bundles src/main/index.ts with `electron` aliased
 * here, so the very same main-process code runs as a headless Node daemon and
 * every client (the phone today, a native desktop app next) reaches it over
 * HTTP. Nothing in index.ts changes for this first step. The daemon boots only
 * through entry.ts, which refuses to unless it is isolated (isolation.ts).
 *
 * WHAT IS REAL: paths, version, lifecycle events, the single-instance lock
 * (Electron's own SingletonLock link, so the daemon and the app see each
 * other), opening a URL, keeping the Mac awake (caffeinate), the clipboard.
 * WHAT IS NOT: windows, IPC callers, dialogs, notifications, screen capture
 * and safeStorage. Those answer "absent", and a dialog that asks the person
 * something FAILS rather than answering for them. Every member nobody wrote
 * here is logged once when touched (`missing`), so a boot names what is left.
 */
import { EventEmitter } from 'node:events'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PendingPort, PortHub, RelayedPort } from './owner-ports'

/** What the daemon's launcher said, read once; the variables then leave process.env. */
const launch = {
  userData: process.env.COOKREWD_USER_DATA,
  appRoot: process.env.COOKREWD_APP_ROOT,
  isDaemon: process.env.COOKREWD === '1'
}

/**
 * Panes inherit the daemon's environment (pty.ts · sanitizeAgentEnv). An agent
 * there must not get ELECTRON_RUN_AS_NODE (its `npx electron` would be plain
 * Node) or the daemon's own switches, so they go before anything spawns.
 */
for (const key of Object.keys(process.env)) {
  if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('COOKREWD')) delete process.env[key]
}

const reported = new Set<string>()

/** Log a member that was used but has no daemon answer, once per member. */
function missing(name: string): void {
  if (reported.has(name)) return
  reported.add(name)
  console.error(`[cookrewd] electron.${name} is not available in the daemon`)
}

/**
 * Members that callers probe rather than call. Answering them with a function
 * would make `await x` hang for ever (a thenable that never settles) or make a
 * serializer or a test matcher misread the object.
 */
const PROBED = new Set(['then', 'toJSON', 'asymmetricMatch', '$$typeof', 'constructor'])

/** An object that answers its known members and logs any other one touched. */
function loud<T extends object>(name: string, known: T): T {
  return new Proxy(known, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol' || prop in target) return Reflect.get(target, prop, receiver)
      if (PROBED.has(prop)) return undefined
      missing(`${name}.${prop}`)
      return () => undefined
    }
  })
}

/** The repository (or app) root: the first folder above this file with a package.json. */
function findAppRoot(): string {
  if (launch.appRoot) return launch.appRoot
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  return process.cwd()
}

const appRoot = findAppRoot()

let version: string | null = null
function packageVersion(): string {
  if (version !== null) return version
  try {
    version = (JSON.parse(readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch (error) {
    console.error('[cookrewd] reading the version from package.json failed:', error)
    version = '0.0.0'
  }
  return version
}

/** Where Electron keeps each named path on a Mac, for this app's name. */
function pathFor(name: string): string {
  const home = homedir()
  const support = path.join(home, 'Library', 'Application Support')
  switch (name) {
    case 'home':
      return home
    case 'appData':
      return support
    case 'userData':
      return launch.userData ?? path.join(support, 'cookrew')
    case 'temp':
      return tmpdir()
    case 'logs':
      return path.join(home, 'Library', 'Logs', 'cookrew')
    case 'downloads':
      return path.join(home, 'Downloads')
    case 'desktop':
      return path.join(home, 'Desktop')
    case 'documents':
      return path.join(home, 'Documents')
    case 'exe':
      return process.execPath
    default:
      missing(`app.getPath(${name})`)
      return path.join(support, 'cookrew', name)
  }
}

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Electron's (Chromium's) single-instance lock: `<userData>/SingletonLock`, a
 * symlink to `<host>-<pid>`. Read and written the same way, so a daemon and an
 * Electron app on one userData refuse each other, as two apps do.
 */
export function takeSingletonLock(userData: string, pid = process.pid, host = hostname()): boolean {
  const lock = path.join(userData, 'SingletonLock')
  try {
    const held = readlinkSync(lock)
    const dash = held.lastIndexOf('-')
    const holderHost = held.slice(0, dash)
    const holderPid = Number(held.slice(dash + 1))
    if (holderPid === pid && holderHost === host) return true
    if (holderHost !== host || (Number.isInteger(holderPid) && processAlive(holderPid))) return false
    unlinkSync(lock) // a lock its process left behind
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('[cookrewd] reading the single-instance lock failed; refusing to share it:', error)
      return false
    }
  }
  try {
    mkdirSync(userData, { recursive: true })
    symlinkSync(`${host}-${pid}`, lock)
    process.once('exit', () => {
      try {
        if (readlinkSync(lock) === `${host}-${pid}`) unlinkSync(lock)
      } catch {
        // already gone
      }
    })
    return true
  } catch (error) {
    console.error('[cookrewd] taking the single-instance lock failed:', error)
    return false
  }
}

type QuitEvent = { defaultPrevented: boolean; preventDefault: () => void }
const quitEvent = (): QuitEvent => {
  const event: QuitEvent = {
    defaultPrevented: false,
    preventDefault: () => {
      event.defaultPrevented = true
    }
  }
  return event
}

class DaemonApp extends EventEmitter {
  readonly isPackaged = false
  readonly commandLine = { appendSwitch: (): void => undefined, hasSwitch: (): boolean => false, getSwitchValue: (): string => '' }
  readonly dock = undefined
  private readied = false

  whenReady(): Promise<void> {
    return Promise.resolve().then(() => {
      if (this.readied) return
      this.readied = true
      this.emit('ready')
    })
  }
  isReady(): boolean {
    return true
  }
  getPath(name: string): string {
    return pathFor(name)
  }
  getAppPath(): string {
    return appRoot
  }
  getVersion(): string {
    return packageVersion()
  }
  getName(): string {
    return 'Cookrew'
  }
  getLocale(): string {
    return Intl.DateTimeFormat().resolvedOptions().locale
  }
  requestSingleInstanceLock(): boolean {
    return takeSingletonLock(pathFor('userData'))
  }
  setAsDefaultProtocolClient(): boolean {
    return false
  }
  setLoginItemSettings(): void {
    missing('app.setLoginItemSettings')
  }
  getLoginItemSettings(): { openAtLogin: boolean } {
    return { openAtLogin: false }
  }
  focus(): void {}
  /** Electron's order: before-quit (may be prevented), will-quit (may be prevented), quit, exit. */
  quit(): void {
    const before = quitEvent()
    this.emit('before-quit', before)
    if (before.defaultPrevented) return
    const will = quitEvent()
    this.emit('will-quit', will)
    if (will.defaultPrevented) return
    this.emit('quit', {}, 0)
    process.exit(0)
  }
  /** As Electron's app.exit: no quit events, the process just ends. */
  exit(code = 0): void {
    process.exit(code)
  }
  relaunch(): void {
    missing('app.relaunch (the launcher restarts the daemon)')
  }
}

export const app = loud('app', new DaemonApp())

/** A daemon quits as Electron's app does on a signal: the quit events run, then the process ends. */
if (launch.isDaemon) {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => app.quit())
}

/**
 * THE OWNER'S WINDOW, held by the owner's app across the owner link
 * (owner-link.ts). Only the window main builds with the app's own preload
 * (index.ts · createWindow) is it: its webContents.send goes to the owner, and
 * the page it loads is the owner page. Any other window (a capture host, a boot
 * failure screen) is inert, as before.
 */
/** Hands the owner one event; false when it was not sent. Essential events are never dropped for backlog. */
type OwnerSink = (channel: string, args: readonly unknown[], essential?: boolean) => boolean | void
let ownerSink: OwnerSink | null = null
let ownerContents: object | null = null
/** The owner window and its webContents as emitters, for the real window's lifecycle events. */
let ownerWindowEmitter: EventEmitter | null = null
let ownerContentsEmitter: EventEmitter | null = null
let ownerPage: string | null = null

/** MessagePorts handed to the owner window, relayed across the owner link (owner-ports.ts). */
const portHub = new PortHub(() => (ownerSink === null ? null : (channel, args, essential) => ownerSink?.(channel, args, essential) !== false))

/** Window events sent before the owner connected, handed over when it does (bounded). */
const EARLY_EVENTS_MAX = 1000
let earlyEvents: { channel: string; args: readonly unknown[] }[] = []
let earlyDropped = 0
let ownerHasConnected = false

function toOwner(channel: string, args: readonly unknown[]): void {
  if (ownerSink !== null) {
    ownerSink(channel, args)
    return
  }
  if (ownerHasConnected) return // the owner left: nobody to tell
  if (earlyEvents.length < EARLY_EVENTS_MAX) earlyEvents = [...earlyEvents, { channel, args }]
  else earlyDropped += 1
}

/**
 * Boot is done when the owner window has loaded its page: main registers every
 * IPC handler (registerIpc) before it creates the window (index.ts · whenReady).
 */
let markOwnerReady: () => void = () => undefined
const ownerReady = new Promise<void>((resolve) => {
  markOwnerReady = resolve
})
let ownerIsReady = false
const ownerLoaded = (page: string): void => {
  ownerPage = page
  ownerIsReady = true
  markOwnerReady()
}

const isOwnerWindowOptions = (options: unknown): boolean => {
  const preload = (options as { webPreferences?: { preload?: unknown } } | undefined)?.webPreferences?.preload
  return typeof preload === 'string' && /[\\/]preload[\\/]index\.c?js$/.test(preload)
}

export class BrowserWindow extends EventEmitter {
  static getAllWindows(): BrowserWindow[] {
    return []
  }
  static getFocusedWindow(): null {
    return null
  }
  readonly webContents: EventEmitter & { send: (channel: string, ...args: unknown[]) => void; isDestroyed: () => boolean }
  private readonly owner: boolean
  constructor(options?: unknown) {
    super()
    this.owner = isOwnerWindowOptions(options) && ownerContents === null
    const contents = Object.assign(new EventEmitter(), {
      /** Electron numbers webContents from 1; the owner window is the daemon's only one. */
      id: this.owner ? 1 : 0,
      send: (channel: string, ...args: unknown[]): void => {
        if (this.owner) toOwner(channel, args)
      },
      isDestroyed: (): boolean => !this.owner,
      /** Ports handed to the owner window cross as relayed ports (owner-ports.ts). */
      postMessage: (channel: string, message: unknown, transfer?: readonly unknown[]): void => {
        if (!this.owner) return missing(`webContents.postMessage(${channel}) on a window that is not the owner's`)
        portHub.handOver(channel, message, transfer ?? [])
      },
      capturePage: (): Promise<never> => Promise.reject(new Error('cookrewd cannot see the owner window; the app captures it'))
    })
    this.webContents = loud('webContents', contents)
    if (this.owner) {
      ownerContents = this.webContents
      ownerWindowEmitter = this
      ownerContentsEmitter = contents
    }
    else missing('BrowserWindow (a window other than the owner window was asked for)')
    return loud('BrowserWindow', this)
  }
  isDestroyed(): boolean {
    return !this.owner
  }
  isMinimized(): boolean {
    return false
  }
  isVisible(): boolean {
    return this.owner
  }
  isFocused(): boolean {
    return this.owner && ownerSink !== null
  }
  show(): void {}
  focus(): void {}
  restore(): void {}
  loadURL(url: string): Promise<void> {
    if (this.owner) ownerLoaded(url)
    return Promise.resolve()
  }
  loadFile(file: string): Promise<void> {
    if (this.owner) ownerLoaded(pathToFileURL(path.resolve(file)).href)
    return Promise.resolve()
  }
}

/** Handlers are kept: the owner link calls them as the owner window would have. */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
export const ipcMain = loud('ipcMain', Object.assign(new EventEmitter(), {
  handle(channel: string, handler: (...args: unknown[]) => unknown): void {
    handlers.set(channel, handler)
  },
  removeHandler(channel: string): void {
    handlers.delete(channel)
  }
}))

/**
 * The event Electron would have built for a call from the owner window's top
 * frame: the owner checks (owner-grant.ts · isOwnerSender, isOwnerPage) hold
 * for it, and for nothing else, because only the owner link makes one.
 */
function ownerEvent(): { sender: object; senderFrame: { parent: null; url: string }; ports: never[] } {
  if (ownerContents === null || ownerPage === null) throw new Error('the owner window is not up yet')
  return { sender: ownerContents, senderFrame: { parent: null, url: ownerPage }, ports: [] }
}

const BOOT_WAIT_MS = 30_000

/** The meta request for the channel list; `$` keeps it apart from every IPC channel (they are `area:verb`). */
export const OWNER_CHANNELS = '$channels'

/** Channels main answers (ipcMain.handle) and listens on (ipcMain.on), once boot is done. */
function ownerChannels(): { handle: string[]; on: string[] } {
  const on = ipcMain.eventNames().filter((name): name is string => typeof name === 'string' && ipcMain.listenerCount(name) > 0)
  return { handle: [...handlers.keys()].sort(), on: on.sort() }
}

/** Boot done, or a refusal after BOOT_WAIT_MS. One promise for every waiter: no polling. */
function booted(): Promise<void> {
  if (ownerIsReady) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the owner window was not up within ${BOOT_WAIT_MS} ms`)), BOOT_WAIT_MS)
    void ownerReady.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** What the owner link calls: main's own handlers, with the owner's event. */
export const ownerDispatch = {
  async invoke(channel: string, args: readonly unknown[]): Promise<unknown> {
    await booted()
    // The one request that is not main's own: which channels main serves, so
    // the owner's app can register a forwarder for each (shell/index.ts).
    if (channel === OWNER_CHANNELS) return ownerChannels()
    const handler = handlers.get(channel)
    if (handler === undefined) throw new Error(`no handler for ${channel}`)
    return handler(ownerEvent(), ...args)
  },
  window(target: 'window' | 'contents', name: string, args: readonly unknown[]): void {
    ownerWindowEvent(target, name, args)
  },
  /** As ipcRenderer.send: fire and forget, delivered once boot is done. */
  send(channel: string, args: readonly unknown[]): void {
    // The owner's end of a relayed port talking back (owner-ports.ts), not an IPC channel.
    if (portHub.fromOwner(channel, args)) return
    const deliver = (): void => {
      ipcMain.emit(channel, ownerEvent(), ...args)
    }
    if (ownerIsReady) deliver()
    else booted().then(deliver, (error: unknown) => console.error(`[cookrewd] owner send ${channel} dropped: ${String(error)}`))
  }
}

/**
 * The real window's lifecycle events the owner's app may tell (shell/bridge.ts
 * · FORWARDED_*): main's own listeners on its owner window run for them. Any
 * other name is refused, so the link cannot fake an input or a navigation the
 * window did not make.
 */
const WINDOW_EVENTS: Readonly<Record<'window' | 'contents', ReadonlySet<string>>> = {
  window: new Set(['focus', 'blur', 'show', 'hide', 'minimize', 'restore', 'closed']),
  contents: new Set(['did-finish-load', 'dom-ready', 'did-start-navigation', 'render-process-gone', 'destroyed'])
}

function ownerWindowEvent(target: 'window' | 'contents', name: string, args: readonly unknown[]): void {
  if (!WINDOW_EVENTS[target].has(name)) {
    console.error(`[cookrewd] the owner link may not emit ${target} ${name}; refused`)
    return
  }
  const emitter = target === 'window' ? ownerWindowEmitter : ownerContentsEmitter
  emitter?.emit(name, ...args)
}

/** The owner's app connected (a sink for its window's events) or left (null). */
export function connectOwner(sink: OwnerSink | null): void {
  ownerSink = sink
  if (sink === null) {
    portHub.closeAll()
    return
  }
  ownerHasConnected = true
  const held = earlyEvents
  earlyEvents = []
  for (const event of held) sink(event.channel, event.args)
  if (earlyDropped > 0) console.error(`[cookrewd] ${earlyDropped} window event(s) from before the owner connected were dropped`)
  earlyDropped = 0
}

/** The IPC channels main registered: what D0's HTTP inventory must cover. */
export const daemonIpcChannels = (): readonly string[] => [...handlers.keys()]

/**
 * Nobody is at a daemon's screen. A file picker is cancelled; a question is
 * REFUSED, never answered for the person (a "turn on remote control?" box
 * answered 0 could mean yes).
 */
export const dialog = loud('dialog', {
  showOpenDialog: (): Promise<{ canceled: true; filePaths: string[] }> => Promise.resolve({ canceled: true, filePaths: [] }),
  showSaveDialog: (): Promise<{ canceled: true; filePath: undefined }> => Promise.resolve({ canceled: true, filePath: undefined }),
  showMessageBox: (): Promise<never> => Promise.reject(new Error('cookrewd has no screen to ask on')),
  showErrorBox: (title: string, content: string): void => console.error(`[cookrewd] ${title}: ${content}`)
})

export const Menu = loud('Menu', { setApplicationMenu: (): void => undefined, buildFromTemplate: (): unknown => loud('Menu.instance', {}) })

export class Tray {
  constructor() {
    missing('Tray')
    return loud('Tray', this)
  }
  setToolTip(): void {}
  setTitle(): void {}
  setContextMenu(): void {}
  destroy(): void {}
}

export class Notification extends EventEmitter {
  static isSupported(): boolean {
    return false
  }
  show(): void {
    missing('Notification.show')
  }
}

export const powerMonitor = loud('powerMonitor', Object.assign(new EventEmitter(), { getSystemIdleTime: (): number => 0, isOnBatteryPower: (): boolean => false }))

/** caffeinate's flags for each of Electron's blocker types; bound to this process's life (-w). */
export const caffeinateArgs = (type: string, pid: number): string[] =>
  type === 'prevent-display-sleep' ? ['-d', '-i', '-w', String(pid)] : ['-i', '-w', String(pid)]

const blockers = new Map<number, ChildProcess>()
let nextBlocker = 1
export const powerSaveBlocker = {
  start(type: string): number {
    const id = nextBlocker++
    const child = spawn('/usr/bin/caffeinate', caffeinateArgs(type, process.pid), { stdio: 'ignore' })
    child.on('error', (error) => console.error('[cookrewd] caffeinate failed:', error))
    child.on('exit', () => blockers.delete(id))
    blockers.set(id, child)
    return id
  },
  stop(id: number): void {
    blockers.get(id)?.kill()
    blockers.delete(id)
  },
  isStarted(id: number): boolean {
    const child = blockers.get(id)
    return child !== undefined && child.exitCode === null && child.signalCode === null
  }
}

/** Unavailable until the daemon reads Electron's keychain item itself (a D0 migration item). */
export const safeStorage = loud('safeStorage', {
  isEncryptionAvailable: (): boolean => false,
  encryptString: (_plain: string): Buffer => {
    throw new Error('safeStorage is not available in the daemon yet')
  },
  decryptString: (_sealed: Buffer): string => {
    throw new Error('safeStorage is not available in the daemon yet')
  }
})

/** `open`, settling as Electron's shell does: rejected when it fails. */
const openWith = (args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`open exited ${code}`))))
  })

export const shell = loud('shell', {
  openExternal: (url: string): Promise<void> => openWith([url]),
  /** Electron answers an error string, empty on success. */
  openPath: (target: string): Promise<string> => openWith([target]).then(() => '', (error: Error) => error.message),
  showItemInFolder: (target: string): void => {
    openWith(['-R', target]).catch((error) => console.error('[cookrewd] open -R failed:', error))
  }
})

const CLIPBOARD_TIMEOUT_MS = 2_000
export const clipboard = loud('clipboard', {
  readText: (): string => {
    try {
      return execFileSync('/usr/bin/pbpaste', { encoding: 'utf8', timeout: CLIPBOARD_TIMEOUT_MS })
    } catch (error) {
      console.error('[cookrewd] pbpaste failed:', error)
      return ''
    }
  },
  writeText: (text: string): void => {
    try {
      execFileSync('/usr/bin/pbcopy', { input: text, timeout: CLIPBOARD_TIMEOUT_MS })
    } catch (error) {
      console.error('[cookrewd] pbcopy failed:', error)
    }
  }
})

export const systemPreferences = loud('systemPreferences', {
  getMediaAccessStatus: (): string => 'unknown',
  isTrustedAccessibilityClient: (): boolean => false,
  canPromptTouchID: (): boolean => false,
  promptTouchID: (): Promise<never> => Promise.reject(new Error('cookrewd has no Touch ID to ask')),
  getUserDefault: (): undefined => undefined
})

export const screen = loud('screen', Object.assign(new EventEmitter(), {
  getAllDisplays: (): unknown[] => [],
  getPrimaryDisplay: (): unknown => ({ id: 0, bounds: { x: 0, y: 0, width: 0, height: 0 }, size: { width: 0, height: 0 }, scaleFactor: 1 })
}))

export const desktopCapturer = { getSources: (): Promise<unknown[]> => Promise.resolve([]) }

const emptyImage = (): unknown => loud('NativeImage', { isEmpty: (): boolean => true, toPNG: (): Buffer => Buffer.alloc(0), toDataURL: (): string => '', getSize: () => ({ width: 0, height: 0 }) })
export const nativeImage = loud('nativeImage', { createEmpty: emptyImage, createFromPath: emptyImage, createFromBuffer: emptyImage, createFromDataURL: emptyImage })

export const net = loud('net', { fetch: (input: string | URL | Request, init?: RequestInit): Promise<Response> => fetch(input, init) })

/** A pair whose second port, handed to the owner window, is relayed across the owner link. */
export class MessageChannelMain {
  readonly port1: RelayedPort
  readonly port2: PendingPort
  constructor() {
    const { port1, port2 } = portHub.channel()
    this.port1 = port1
    this.port2 = port2
  }
}

const emptySession = (): unknown => loud('session.instance', {})
export const session = loud('session', { defaultSession: emptySession(), fromPartition: emptySession })
export const webUtils = loud('webUtils', {})

export default {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  Tray,
  Notification,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  shell,
  clipboard,
  systemPreferences,
  screen,
  desktopCapturer,
  nativeImage,
  net,
  MessageChannelMain,
  session,
  webUtils
}
