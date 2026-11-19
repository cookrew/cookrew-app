import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { writeFileAtomic } from '../atomic-file'
import { checkFilePrivacy, writePrivateFile, type FilePrivacyDeps } from '../file-privacy'

/**
 * MAGPIE'S OWN SETTINGS, INSIDE COOKREW. `magpie web` serves the app's window as a
 * page (magpie 0.1.3935): accounts, providers, routing groups, gateway keys and a
 * Remote magpie provider, all in Magpie's own words. It shares the running app's
 * settings and lets that app keep the gateway. Cookrew starts it on loopback and
 * opens it in a browser card, so a person configures Magpie without leaving Cookrew
 * and on a box with no desktop (Linux over SSH) too.
 *
 * THE KEY. Magpie signs a browser in with an HttpOnly cookie named after the PORT
 * whose value is the key (`magpie_web_<port>=<key>`; `?k=<key>` is how a person's
 * browser gets it). So the key and the port are kept together (in the served
 * sandbox's deny list) and reused. The file is PROVEN private before the key is
 * kept or reused (file-privacy.ts): 0600 on POSIX, its owner and access list on
 * Windows; a saved key whose file is not proven is replaced by a new one, since
 * the old one may have been read. The key reaches Magpie in its environment, never
 * on a command line, and it never becomes a link: open() answers with the bare
 * address and the cookie, and the cookie stays in main, which sets it into the
 * card's own browser session (main/magpie-card-open.ts). A seat that could read the
 * environment still cannot use it: every port in MAGPIE_WEB_PORTS is denied to the
 * sandbox (route/service.ts · gatewayPorts).
 *
 * THE PAGE MUST BE OURS. The cookie is the key, so before it is handed over the
 * process listening on the port is checked to be the one this module started
 * (lsof, or ss on Linux; magpie web listens in the process it was started as,
 * 0.1.3935). Another program answering there, a squatter, gets nothing. FAIL
 * CLOSED: where the listener cannot be read or more than one process listens,
 * nothing is opened. A same-user program that takes the port in the moment between
 * the check and the card's first request is not ruled out (the TOCTOU): the window
 * is made short, not closed. A served seat cannot take these ports at all
 * (sandbox-deny.ts · network-bind).
 */

export const MAGPIE_WEB_PORTS: readonly number[] = [3431, 3432, 3433, 3434, 3435, 3436, 3437, 3438, 3439, 3440]
export const MAGPIE_WEB_FILE = 'magpie-web.json'
const KEY_RE = /^[A-Za-z0-9._~-]{16,128}$/
const READY_MS = 15_000
const STEP_MS = 250

/** MAIN ONLY: `cookie.value` is the page's key. Never hand this to a renderer (magpie-card-open.ts strips it). */
export type MagpieWebOpen =
  | { readonly ok: true; readonly url: string; readonly port: number; readonly cookie: { readonly name: string; readonly value: string } }
  | { readonly ok: false; readonly why: string }

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
  /** How the key's file is proven private; this OS by default (tests fake Windows). */
  readonly privacy?: FilePrivacyDeps
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

export const bareUrlOf = (port: number): string => `http://127.0.0.1:${port}/`

/** Magpie's sign-in cookie for the page on this port. */
export const cookieOf = (port: number, key: string): { name: string; value: string } => ({ name: `magpie_web_${port}`, value: key })

const opened = (held: Held): MagpieWebOpen => ({ ok: true, url: bareUrlOf(held.port), port: held.port, cookie: cookieOf(held.port, held.key) })

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

function lsofListeners(port: number): Promise<number[] | null> {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-t'], { timeout: 3_000 }, (error, stdout) => {
      const pids = String(stdout).split('\n').map((line) => Number(line.trim())).filter((pid) => Number.isInteger(pid) && pid > 0)
      // lsof exits 1 with nothing to list; anything else without output is "cannot tell".
      if (pids.length > 0) return resolve(pids)
      resolve(error && (error as { code?: unknown }).code === 1 ? [] : null)
    })
  })
}

const REACHES_LOOPBACK = new Set(['127.0.0.1', '0.0.0.0', '*', '[::]', '[::ffff:127.0.0.1]', '[::ffff:0.0.0.0]'])

/** `ss -Hltnp` lines: `LISTEN 0 4096 127.0.0.1:3431 0.0.0.0:* users:(("magpie",pid=123,fd=7))`. */
export function parseSsListeners(text: string, port: number): number[] | null {
  const pids: number[] = []
  for (const line of text.split('\n')) {
    const cells = line.trim().split(/\s+/)
    // Any listener that loopback connections to the port can reach: 127.0.0.1 and every wildcard.
    if (cells.length < 5 || !REACHES_LOOPBACK.has(cells[3].slice(0, cells[3].lastIndexOf(':'))) || cells[3].slice(cells[3].lastIndexOf(':') + 1) !== String(port)) continue
    const found = [...line.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]))
    // A listener ss could not name the owner of (another user's): cannot tell.
    if (found.length === 0) return null
    pids.push(...found)
  }
  return [...new Set(pids)]
}

function ssListeners(port: number): Promise<number[] | null> {
  return new Promise((resolve) => {
    execFile('ss', ['-Hltnp', `sport = :${port}`], { timeout: 3_000 }, (error, stdout) => {
      resolve(error ? null : parseSsListeners(String(stdout), port))
    })
  })
}

/** The PIDs listening on 127.0.0.1:<port>: lsof, else ss on Linux; null when neither can tell. */
async function loopbackListeners(port: number): Promise<number[] | null> {
  const viaLsof = await lsofListeners(port)
  if (viaLsof !== null || process.platform !== 'linux') return viaLsof
  return ssListeners(port)
}

/** Is the key's file proven private now? Unproven, or unreadable, is no. */
async function provenPrivate(file: string, privacy: FilePrivacyDeps): Promise<boolean> {
  try {
    return !(await checkFilePrivacy(file, privacy)).open
  } catch {
    return false
  }
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
      return opened(this.held)
    }
    const privacy = this.deps.privacy ?? {}
    const saved = readHeld(this.deps.file)
    const free = this.deps.portFree ?? portFreeOnLoopback
    const port = saved !== null && (await free(saved.port)) ? saved.port : await this.firstFree(free)
    if (port === null) return { ok: false, why: `No free port for Magpie's page (${MAGPIE_WEB_PORTS[0]}–${MAGPIE_WEB_PORTS.at(-1)}).` }
    // The port is no secret; the key is reused only from a file proven private.
    const keptKey = saved !== null && (await provenPrivate(this.deps.file, privacy)) ? saved.key : null
    const held: Held = { key: keptKey ?? newKey(), port }
    try {
      mkdirSync(path.dirname(this.deps.file), { recursive: true, mode: 0o700 })
      const text = `${JSON.stringify(held)}\n`
      if ((privacy.platform ?? process.platform) === 'win32') {
        // Windows: created with a private access list and kept only once proven private by owner and list.
        await writePrivateFile(this.deps.file, text, privacy)
      } else {
        // POSIX: 0600 through `magpie-web.json.tmp`, the temp name the served-seat deny list names
        // (owner-secrets.ts). writePrivateFile's temp has a random name no deny entry covers, and a
        // served seat runs as this user, so a mode alone would not keep the key from it.
        writeFileAtomic(this.deps.file, text)
      }
    } catch {
      return { ok: false, why: 'Could not keep the key for Magpie’s page.' }
    }
    const child = (this.deps.start ?? startMagpieWeb)(bin, port, held.key)
    child.once('exit', () => {
      if (this.child === child) this.child = null
    })
    // A binary that cannot be started (moved mid-update, no permission) is an answer, not a crash of main.
    child.once('error', () => {
      if (this.child === child) this.child = null
    })
    this.child = child
    this.held = held
    const wait = this.deps.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    for (let waited = 0; waited < READY_MS; waited += STEP_MS) {
      if (child.exitCode !== null || this.child !== child) return { ok: false, why: 'Magpie’s page stopped as it started. Run `magpie web` in a terminal to see why.' }
      if (await answers(port)) {
        if (!(await this.ours(child, port))) return this.squatted(port)
        return opened(held)
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
