import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { writeFileAtomic } from '../atomic-file'

/**
 * MAGPIE'S OWN SETTINGS, INSIDE COOKREW. `magpie web` serves the app's window as a
 * page (magpie 0.1.3935): accounts, providers, routing groups, gateway keys and a
 * Remote magpie provider, all in Magpie's own words. It shares the running app's
 * settings and lets that app keep the gateway. Cookrew starts it on loopback and
 * opens it in a browser card, so a person configures Magpie without leaving Cookrew
 * and on a box with no desktop (Linux over SSH) too.
 *
 * THE KEY. Magpie asks for `?k=<key>` once, answers 303 to `/` and sets an
 * HttpOnly cookie named after the PORT, good for 400 days. So the key and the port
 * are kept together (0600, in the served sandbox's deny list) and reused: a new
 * port would be a new cookie and a new sign-in. The key reaches Magpie in its
 * environment, never on a command line. A seat that could read that environment
 * still cannot use it: every port in MAGPIE_WEB_PORTS is denied to the sandbox
 * (route/service.ts · gatewayPorts).
 *
 * THE PAGE MUST BE OURS. The link carries the key, so before it is handed over the
 * process listening on the port is checked to be the one this module started
 * (lsof; magpie web listens in the process it was started as, 0.1.3935). Another
 * program answering there, a squatter, gets nothing. FAIL CLOSED: where the listener
 * cannot be read (no lsof) or more than one process listens, nothing is opened. A
 * same-user program that takes the port in the moment between the check and the
 * card's first load is not ruled out: the window is made short, not closed. A served
 * seat cannot take these ports at all (sandbox-deny.ts · network-bind).
 */

export const MAGPIE_WEB_PORTS: readonly number[] = [3431, 3432, 3433, 3434, 3435, 3436, 3437, 3438, 3439, 3440]
export const MAGPIE_WEB_FILE = 'magpie-web.json'
const KEY_RE = /^[A-Za-z0-9._~-]{16,128}$/
const READY_MS = 15_000
const STEP_MS = 250

export type MagpieWebOpen = { readonly ok: true; readonly url: string; readonly port: number } | { readonly ok: false; readonly why: string }

interface Held {
  readonly key: string
  readonly port: number
}

export interface MagpieWebDeps {
  /** The magpie CLI, or null when Magpie is not here. */
  readonly bin: () => string | null
  readonly file: string
  readonly portFree?: (port: number) => Promise<boolean>
  /** Does a page answer there (any HTTP status)? */
  readonly answers?: (port: number) => Promise<boolean>
  readonly start?: (bin: string, port: number, key: string) => ChildProcess
  readonly wait?: (ms: number) => Promise<void>
  /** The PIDs listening on a loopback port, or null when that cannot be read. */
  readonly listeners?: (port: number) => Promise<number[] | null>
}

export function readHeld(file: string, read: (f: string) => string = (f) => readFileSync(f, 'utf8')): Held | null {
  try {
    const parsed = JSON.parse(read(file)) as { key?: unknown; port?: unknown }
    if (typeof parsed.key !== 'string' || !KEY_RE.test(parsed.key)) return null
    if (typeof parsed.port !== 'number' || !MAGPIE_WEB_PORTS.includes(parsed.port)) return null
    return { key: parsed.key, port: parsed.port }
  } catch {
    return null
  }
}

export const newKey = (): string => `cookrew-${randomBytes(24).toString('hex')}`

export const linkOf = (port: number, key: string): string => `http://127.0.0.1:${port}/?k=${key}`

function portFreeOnLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

async function answersOnLoopback(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(1_000) })
    await response.body?.cancel()
    return true
  } catch {
    return false
  }
}

function loopbackListeners(port: number): Promise<number[] | null> {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 3_000 }, (error, stdout) => {
      const pids = String(stdout).split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0)
      // lsof exits 1 with nothing to list; anything else without output is "cannot tell".
      if (pids.length > 0) return resolve(pids)
      resolve(error && (error as { code?: unknown }).code === 1 ? [] : null)
    })
  })
}

function startMagpieWeb(bin: string, port: number, key: string): ChildProcess {
  return spawn(bin, ['web', '--no-open', '--addr', `127.0.0.1:${port}`], {
    env: { ...process.env, MAGPIE_WEB_KEY: key },
    stdio: 'ignore',
    detached: false
  })
}

export class MagpieWeb {
  private child: ChildProcess | null = null
  private held: Held | null = null
  private opening: Promise<MagpieWebOpen> | null = null

  constructor(private readonly deps: MagpieWebDeps) {}

  /** The page's sign-in link; starts Magpie's page first when it is not running. One start at a time. */
  open(): Promise<MagpieWebOpen> {
    if (this.opening) return this.opening
    this.opening = this.openNow().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async openNow(): Promise<MagpieWebOpen> {
    const bin = this.deps.bin()
    if (bin === null) return { ok: false, why: 'Magpie is not installed on this computer.' }
    const answers = this.deps.answers ?? answersOnLoopback
    if (this.child !== null && this.child.exitCode === null && this.held !== null && (await answers(this.held.port))) {
      if (!(await this.ours(this.child, this.held.port))) return this.squatted(this.held.port)
      return { ok: true, url: linkOf(this.held.port, this.held.key), port: this.held.port }
    }
    const saved = readHeld(this.deps.file)
    const free = this.deps.portFree ?? portFreeOnLoopback
    const port = saved !== null && (await free(saved.port)) ? saved.port : await this.firstFree(free)
    if (port === null) return { ok: false, why: `No free port for Magpie's page (${MAGPIE_WEB_PORTS[0]}–${MAGPIE_WEB_PORTS.at(-1)}).` }
    const held: Held = { key: saved?.key ?? newKey(), port }
    try {
      mkdirSync(path.dirname(this.deps.file), { recursive: true, mode: 0o700 })
      // 0600, through the temp-and-rename every owner file uses.
      writeFileAtomic(this.deps.file, `${JSON.stringify(held)}\n`)
    } catch {
      return { ok: false, why: 'Could not keep the key for Magpie’s page.' }
    }
    const child = (this.deps.start ?? startMagpieWeb)(bin, port, held.key)
    child.once('exit', () => {
      if (this.child === child) this.child = null
    })
    this.child = child
    this.held = held
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let waited = 0; waited < READY_MS; waited += STEP_MS) {
      if (child.exitCode !== null) return { ok: false, why: 'Magpie’s page stopped as it started. Run `magpie web` in a terminal to see why.' }
      if (await answers(port)) {
        if (!(await this.ours(child, port))) return this.squatted(port)
        return { ok: true, url: linkOf(port, held.key), port }
      }
      await wait(STEP_MS)
    }
    this.stop()
    return { ok: false, why: 'Magpie’s page did not answer in time.' }
  }

  /** Is the ONLY process listening on the port the one we started? Unknowable or shared counts as no. */
  private async ours(child: ChildProcess, port: number): Promise<boolean> {
    const pids = await (this.deps.listeners ?? loopbackListeners)(port).catch(() => null)
    if (pids === null || child.pid === undefined) return false
    return pids.length === 1 && pids[0] === child.pid
  }

  private squatted(port: number): MagpieWebOpen {
    this.stop()
    return { ok: false, why: `Could not confirm that Magpie’s own page is the one answering on port ${port}, so its settings were not opened.` }
  }

  private async firstFree(free: (port: number) => Promise<boolean>): Promise<number | null> {
    for (const port of MAGPIE_WEB_PORTS) if (await free(port)) return port
    return null
  }

  stop(): void {
    const child = this.child
    this.child = null
    if (child !== null && child.exitCode === null) child.kill()
  }
}
