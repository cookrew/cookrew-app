import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isolationProblems } from '../src/main/daemon/isolation'

/**
 * cookrewd's `electron` (src/main/daemon/electron-shim.ts) and its boot guard
 * (src/main/daemon/isolation.ts): the answers the main process gets when no
 * window exists, and the rule that keeps a daemon off the live fleet.
 */

const LIVE_USER_DATA = path.join(homedir(), 'Library', 'Application Support', 'cookrew')
const DAEMON_KEYS = ['COOKREWD_USER_DATA', 'COOKREWD_APP_ROOT', 'COOKREWD', 'ELECTRON_RUN_AS_NODE']
let saved: Record<string, string | undefined> = {}

const load = async () => {
  vi.resetModules()
  return import('../src/main/daemon/electron-shim')
}

beforeEach(() => {
  saved = Object.fromEntries(DAEMON_KEYS.map((key) => [key, process.env[key]]))
  for (const key of DAEMON_KEYS) delete process.env[key]
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of DAEMON_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

describe('cookrewd boot guard', () => {
  const isolated = { COOKREWD_USER_DATA: '/tmp/cookrewd-x', PATH: '/usr/bin:/bin' }
  const noHerdr = (): boolean => false

  it('lets an isolated daemon boot', () => {
    expect(isolationProblems({ env: isolated, liveUserData: LIVE_USER_DATA, exists: noHerdr })).toEqual([])
  })

  it('refuses without its own userData, or with the live one', () => {
    expect(isolationProblems({ env: { PATH: '/usr/bin' }, liveUserData: LIVE_USER_DATA, exists: noHerdr })).toHaveLength(1)
    expect(
      isolationProblems({ env: { ...isolated, COOKREWD_USER_DATA: LIVE_USER_DATA + '/' }, liveUserData: LIVE_USER_DATA, exists: noHerdr })
    ).toHaveLength(1)
  })

  it('refuses when herdr is reachable on PATH or by its socket', () => {
    const herdrIn = (dir: string) => (file: string) => file === path.join(dir, 'herdr')
    const withHerdr = { ...isolated, PATH: '/usr/bin:/Users/me/.local/bin' }
    expect(isolationProblems({ env: withHerdr, liveUserData: LIVE_USER_DATA, exists: herdrIn('/Users/me/.local/bin') })[0]).toMatch(/herdr is reachable/)
    expect(isolationProblems({ env: { ...isolated, HERDR_SOCKET_PATH: '/x' }, liveUserData: LIVE_USER_DATA, exists: noHerdr })).toHaveLength(1)
    expect(
      isolationProblems({ env: { ...withHerdr, COOKREWD_ALLOW_HERDR: '1' }, liveUserData: LIVE_USER_DATA, exists: herdrIn('/Users/me/.local/bin') })
    ).toEqual([])
  })
})

describe('cookrewd electron shim', () => {
  it('keeps the paths Electron uses for this app', async () => {
    const { app } = await load()
    expect(app.getPath('userData')).toBe(LIVE_USER_DATA)
    expect(app.getPath('home')).toBe(homedir())
    expect(app.isPackaged).toBe(false)
    expect(app.getVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('takes its userData from the launcher, then clears the daemon variables from the environment', async () => {
    process.env.COOKREWD_USER_DATA = '/tmp/cookrewd-test-userdata'
    process.env.ELECTRON_RUN_AS_NODE = '1'
    process.env.COOKREWD = '1'
    const signalsBefore = process.listenerCount('SIGTERM')
    const { app } = await load()
    expect(app.getPath('userData')).toBe('/tmp/cookrewd-test-userdata')
    expect(process.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(process.env.COOKREWD_USER_DATA).toBeUndefined()
    // COOKREWD=1 installs the quit-on-signal handlers; remove them again.
    const added = process.listeners('SIGTERM').slice(signalsBefore)
    expect(added).toHaveLength(1)
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      for (const listener of process.listeners(signal).slice(signal === 'SIGTERM' ? signalsBefore : 0)) {
        if (added.includes(listener) || signal !== 'SIGTERM') process.removeListener(signal, listener as () => void)
      }
    }
  })

  it('installs no signal handler unless it is the daemon', async () => {
    const before = process.listenerCount('SIGTERM')
    await load()
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })

  it('emits ready once however often whenReady is asked', async () => {
    const { app } = await load()
    const ready = vi.fn()
    app.on('ready', ready)
    await app.whenReady()
    await app.whenReady()
    expect(ready).toHaveBeenCalledOnce()
  })

  it('quits in Electron\'s order and honours a prevented before-quit', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const { app } = await load()
    const order: string[] = []
    const stop = (event: { preventDefault: () => void }) => {
      order.push('before-quit')
      event.preventDefault()
    }
    app.on('before-quit', stop)
    app.quit()
    expect(exit).not.toHaveBeenCalled()
    app.off('before-quit', stop)
    app.on('before-quit', () => order.push('before-quit'))
    app.on('will-quit', () => order.push('will-quit'))
    app.on('quit', () => order.push('quit'))
    app.quit()
    expect(order).toEqual(['before-quit', 'before-quit', 'will-quit', 'quit'])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits with no quit events, as Electron\'s app.exit does', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    const { app } = await load()
    const heard = vi.fn()
    app.on('will-quit', heard)
    app.on('quit', heard)
    app.exit(3)
    expect(heard).not.toHaveBeenCalled()
    expect(exit).toHaveBeenCalledWith(3)
  })

  it('records the IPC channels main registers, for the HTTP inventory', async () => {
    const { ipcMain, daemonIpcChannels } = await load()
    ipcMain.handle('pty:list', () => [])
    ipcMain.handle('workspace:get', () => null)
    ipcMain.removeHandler('pty:list')
    expect(daemonIpcChannels()).toEqual(['workspace:get'])
  })

  it('names a member nobody implemented, once, and does not throw', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { app } = await load()
    const loose = app as unknown as { setBadgeCount: () => unknown }
    expect(() => loose.setBadgeCount()).not.toThrow()
    loose.setBadgeCount()
    const said = errors.mock.calls.map((call) => String(call[0]))
    expect(said.filter((line) => line.includes('app.setBadgeCount'))).toHaveLength(1)
  })

  it('never makes a loud object thenable, so awaiting one does not hang', async () => {
    const { app, safeStorage } = await load()
    expect((app as unknown as { then?: unknown }).then).toBeUndefined()
    await expect(Promise.resolve(safeStorage)).resolves.toBe(safeStorage)
  })

  it('cancels a picker and refuses a question rather than answering for the person', async () => {
    const { dialog, systemPreferences } = await load()
    await expect(dialog.showOpenDialog()).resolves.toEqual({ canceled: true, filePaths: [] })
    await expect(dialog.showMessageBox()).rejects.toThrow(/no screen/)
    await expect(systemPreferences.promptTouchID()).rejects.toThrow(/no Touch ID/)
  })

  it('says encryption is unavailable rather than pretending', async () => {
    const { safeStorage } = await load()
    expect(safeStorage.isEncryptionAvailable()).toBe(false)
    expect(() => safeStorage.encryptString('x')).toThrow(/not available/)
  })

  it('opens no window and has none, and an unknown window member is loud, not a crash', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { BrowserWindow, Tray } = await load()
    const window = new BrowserWindow()
    expect(window.isDestroyed()).toBe(true)
    expect(BrowserWindow.getAllWindows()).toEqual([])
    expect(() => (window as unknown as { setTitle: (t: string) => void }).setTitle('x')).not.toThrow()
    expect(() => new Tray().setTitle()).not.toThrow()
  })

  it('maps blocker types to caffeinate flags', async () => {
    const { caffeinateArgs } = await load()
    expect(caffeinateArgs('prevent-display-sleep', 42)).toEqual(['-d', '-i', '-w', '42'])
    expect(caffeinateArgs('prevent-app-suspension', 42)).toEqual(['-i', '-w', '42'])
  })
})

describe('cookrewd single-instance lock', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cookrewd-lock-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('takes a free lock the way Electron writes it', async () => {
    const { takeSingletonLock } = await load()
    expect(takeSingletonLock(dir, 4242, 'mac')).toBe(true)
    expect(readlinkSync(path.join(dir, 'SingletonLock'))).toBe('mac-4242')
  })

  it('refuses a lock a live process holds, as the Electron app would', async () => {
    const { takeSingletonLock } = await load()
    symlinkSync(`${hostname()}-${process.pid}`, path.join(dir, 'SingletonLock'))
    expect(takeSingletonLock(dir, process.pid + 100000, hostname())).toBe(false)
  })

  it('reclaims a lock its process left behind, and refuses another host\'s', async () => {
    const { takeSingletonLock } = await load()
    symlinkSync(`${hostname()}-99999999`, path.join(dir, 'SingletonLock'))
    expect(takeSingletonLock(dir, 4243, hostname())).toBe(true)
    rmSync(path.join(dir, 'SingletonLock'))
    symlinkSync('another-mac-1', path.join(dir, 'SingletonLock'))
    expect(takeSingletonLock(dir, 4244, hostname())).toBe(false)
  })
})

describe('cookrewd build', () => {
  it('bundles main behind the guard with no electron import left', () => {
    const root = path.join(__dirname, '..')
    // Inside the repo: the bundle's external packages resolve from node_modules beside it.
    mkdirSync(path.join(root, 'out'), { recursive: true })
    const outdir = mkdtempSync(path.join(root, 'out', 'cookrewd-test-'))
    try {
      execFileSync(process.execPath, [path.join(root, 'scripts/daemon-build.mjs')], {
        cwd: root,
        stdio: 'pipe',
        env: { ...process.env, COOKREWD_OUTDIR: outdir }
      })
      const bundle = readFileSync(path.join(outdir, 'index.js'), 'utf8')
      expect(bundle).not.toMatch(/from\s*["']electron["']/)
      expect(bundle).not.toMatch(/require\(["']electron["']\)/)
      expect(bundle).toContain('refusing to boot')
      // Behaviour, not text order: started without isolation, the bundle
      // refuses before the main process does anything, and leaves no trace.
      const home = mkdtempSync(path.join(tmpdir(), 'cookrewd-refuse-home-'))
      try {
        let status: number | null = 0
        let stderr = ''
        try {
          execFileSync(process.execPath, [path.join(outdir, 'index.js')], {
            cwd: root,
            stdio: 'pipe',
            env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: home + '/' },
            timeout: 30_000
          })
        } catch (error) {
          const failed = error as { status: number | null; stderr: Buffer }
          status = failed.status
          stderr = String(failed.stderr)
        }
        expect(status).toBe(78)
        expect(stderr).toMatch(/refusing to boot[\s\S]*COOKREWD_USER_DATA/)
        expect(readdirSync(home)).toEqual([])
      } finally {
        rmSync(home, { recursive: true, force: true })
      }
    } finally {
      rmSync(outdir, { recursive: true, force: true })
    }
  }, 120_000)
})
