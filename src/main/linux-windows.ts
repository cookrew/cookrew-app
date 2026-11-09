import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cachedFor, findTool, type XdoCall } from './linux-input'

/**
 * THIS LINUX MACHINE'S WINDOWS, AS X11 SAYS THEM.
 *
 * What the picker lists and a window card is bound to: each window's X id,
 * title, app, process and place on the X screen, read through xdotool (which
 * the hand needs anyway) and, when it is installed, xprop for the app's name.
 * No new dependency, and no window manager needed:
 *
 *   THE LIST is `xdotool search --onlyvisible --name .`: every viewable window
 *   with a title, at any depth. On a bare Xvfb (Solis) the apps are children of
 *   the root; under a reparenting window manager they sit inside frames, and
 *   the search still finds the client. _NET_CLIENT_LIST would need a window
 *   manager, so it is not asked. A frame that carries its client's title is
 *   folded into the client.
 *
 *   THE APP is WM_CLASS's class (xprop), else the process's name (_NET_WM_PID,
 *   /proc), else the title. Old X apps set no pid.
 *
 *   THE PLACE is getwindowgeometry, which xdotool translates to root
 *   coordinates, so a client inside a frame is where it is on the screen.
 *
 * Cookrew's own windows are left out, as on a Mac: a card showing Cookrew
 * inside Cookrew is a mirror facing a mirror. Chromium marks its windows with
 * the browser process's pid, which is this process.
 */

export interface X11Window {
  readonly id: number
  readonly title: string
  readonly app: string
  readonly pid: number | null
  /** Root coordinates: where it is on the X screen, in pixels. */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface X11Deps {
  /** xdotool's stdout for this argv; rejects on a non-zero exit with `code` and `stderr`. */
  xdotool(argv: readonly string[]): Promise<string>
  /** xprop the same way, or null when it is not installed. */
  xprop: ((argv: readonly string[]) => Promise<string>) | null
  /** A process's name, or null. */
  comm(pid: number): string | null
  selfPid: number
}

export type X11Lookup = { readonly state: 'shown'; readonly window: X11Window } | { readonly state: 'hidden' } | { readonly state: 'gone' }

/** Smaller than this is a helper window, not something to pick or drive. */
const MIN_SIDE = 16
/** Facts are read a few windows at a time: each is a process or three. */
const AT_ONCE = 6
/** The most windows looked at: a phone picks from a short list, and each costs processes. */
const MAX_LOOKED_AT = 64
const FOCUS_TIMEOUT_MS = 3000

export function parseIds(stdout: string): number[] {
  return stdout.split('\n').flatMap((line) => (/^\d+$/.test(line.trim()) ? [Number(line.trim())] : []))
}

const GEOMETRY_KEYS = ['WINDOW', 'X', 'Y', 'WIDTH', 'HEIGHT', 'SCREEN'] as const

/** `getwindowname ID getwindowgeometry --shell ID`: the title, then six KEY=value lines. The title is whatever comes before them. */
export function parseGeometry(stdout: string): { title: string; x: number; y: number; width: number; height: number } | null {
  const lines = stdout.replace(/\n$/, '').split('\n')
  const start = lines.length - GEOMETRY_KEYS.length
  if (start < 1) return null
  const values = new Map<string, number>()
  for (const [i, key] of GEOMETRY_KEYS.entries()) {
    const match = new RegExp(`^${key}=(-?\\d+)$`).exec(lines[start + i] ?? '')
    if (!match) return null
    values.set(key, Number(match[1]))
  }
  return { title: lines.slice(0, start).join(' ').trim(), x: values.get('X')!, y: values.get('Y')!, width: values.get('WIDTH')!, height: values.get('HEIGHT')! }
}

/** `WM_CLASS(STRING) = "instance", "Class"`: the class. */
export function parseWmClass(stdout: string): string | null {
  const match = /WM_CLASS\([^)]*\)\s*=\s*"[^"]*",\s*"([^"]*)"/.exec(stdout)
  return match && match[1].trim() !== '' ? match[1].trim() : null
}

/** X said this window does not exist (any more). Anything else proves nothing. */
const isGone = (error: unknown): boolean => /BadWindow|BadDrawable|BadMatch/.test(error instanceof Error ? error.message : String(error))

/** xdotool's search exits 1 with nothing to say when nothing matched. */
const noMatch = (error: unknown): boolean => {
  const e = error as { code?: unknown; stderr?: unknown }
  return e.code === 1 && (typeof e.stderr !== 'string' || e.stderr.trim() === '')
}

async function shownIds(deps: X11Deps): Promise<number[]> {
  try {
    return parseIds(await deps.xdotool(['search', '--onlyvisible', '--name', '.']))
  } catch (error) {
    if (noMatch(error)) return []
    throw error
  }
}

async function appOf(id: number, pid: number | null, title: string, deps: X11Deps): Promise<string> {
  const cls = deps.xprop ? parseWmClass(await deps.xprop(['-id', String(id), 'WM_CLASS']).catch(() => '')) : null
  return cls ?? (pid !== null ? deps.comm(pid) : null) ?? title
}

async function factsOf(id: number, deps: X11Deps): Promise<X11Window> {
  const place = parseGeometry(await deps.xdotool(['getwindowname', String(id), 'getwindowgeometry', '--shell', String(id)]))
  if (!place) throw new Error(`could not read where window ${id} is`)
  const pid = await deps
    .xdotool(['getwindowpid', String(id)])
    .then((out) => parseIds(out)[0] ?? null)
    .catch(() => null)
  return { id, title: place.title, app: await appOf(id, pid, place.title, deps), pid, x: place.x, y: place.y, width: place.width, height: place.height }
}

async function inTurns<T, R>(items: readonly T[], each: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += AT_ONCE) out.push(...(await Promise.all(items.slice(i, i + AT_ONCE).map(each))))
  return out
}

const contains = (outer: X11Window, inner: X11Window): boolean =>
  outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.width >= inner.x + inner.width && outer.y + outer.height >= inner.y + inner.height

/** Every window worth picking: shown, titled, not tiny, not Cookrew's, one row per window. */
export async function listX11Windows(deps: X11Deps): Promise<X11Window[]> {
  const ids = (await shownIds(deps)).slice(0, MAX_LOOKED_AT)
  // One that closed between the search and its facts is not listed.
  const read = await inTurns(ids, (id) => factsOf(id, deps).catch(() => null))
  const windows = read.filter((w): w is X11Window => w !== null && w.pid !== deps.selfPid && w.width >= MIN_SIDE && w.height >= MIN_SIDE)
  // A frame that took its client's title would be the same window twice: keep the client inside.
  return windows.filter((w) => !windows.some((other) => other !== w && other.title === w.title && contains(w, other) && !contains(other, w)))
}

/** The one window a card is bound to, now: shown with its place, alive but not shown, or gone. */
export async function lookupX11Window(id: number, deps: X11Deps): Promise<X11Lookup> {
  let window: X11Window
  try {
    window = await factsOf(id, deps)
  } catch (error) {
    if (isGone(error)) return { state: 'gone' }
    throw error
  }
  return (await shownIds(deps)).includes(id) ? { state: 'shown', window } : { state: 'hidden' }
}

/** A window an address names by app (and title): exact app first, then an app that contains it. */
export function findX11Window(windows: readonly X11Window[], app: string, title: string | null): X11Window | null {
  const wanted = app.toLowerCase()
  const titled = (w: X11Window): boolean => title === null || w.title.toLowerCase().includes(title.toLowerCase())
  return windows.find((w) => w.app.toLowerCase() === wanted && titled(w)) ?? windows.find((w) => w.app.toLowerCase().includes(wanted) && titled(w)) ?? null
}

/**
 * Before any input on a window card, the window comes to the front and takes
 * the keyboard. Activate asks the window manager (_NET_ACTIVE_WINDOW), which
 * is what raises a framed window above the others; with no window manager it
 * fails, which is fine, so it is optional. Raise and focus are plain X calls
 * that work with none. Keys then go to the window through the real keyboard
 * path: xdotool's --window sends synthetic events, which xterm and many apps
 * ignore on purpose.
 */
export function windowFocusCalls(id: number): { readonly optional: XdoCall; readonly required: XdoCall } {
  return {
    optional: { argv: ['windowactivate', String(id)], timeoutMs: FOCUS_TIMEOUT_MS, optional: true },
    required: { argv: ['windowraise', String(id), 'windowfocus', String(id), 'sleep', '0.05'], timeoutMs: FOCUS_TIMEOUT_MS }
  }
}

/** A tool's stdout, started without a shell and with this app's environment (so its DISPLAY). */
export function toolOutput(bin: string, env: NodeJS.ProcessEnv, timeoutMs = 5000): (argv: readonly string[]) => Promise<string> {
  return (argv) =>
    new Promise((resolve, reject) => {
      execFile(bin, [...argv], { env: { ...env }, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (!error) return resolve(String(stdout))
        const said = String(stderr ?? '').trim()
        reject(Object.assign(new Error(`${bin.split('/').pop()}: ${said || error.message}`), { code: (error as { code?: unknown }).code, stderr: said }))
      })
    })
}

const TOOL_LOOKUP_MS = 5000

/** How this machine asks X about windows: null while xdotool is not installed (looked for again every few seconds). */
export function machineX11(env: NodeJS.ProcessEnv, selfPid: number): () => X11Deps | null {
  const xdotool = cachedFor(() => findTool('xdotool', env), TOOL_LOOKUP_MS)
  const xprop = cachedFor(() => findTool('xprop', env), TOOL_LOOKUP_MS)
  return () => {
    const bin = xdotool()
    if (!bin) return null
    const prop = xprop()
    return { xdotool: toolOutput(bin, env), xprop: prop ? toolOutput(prop, env) : null, comm: procComm, selfPid }
  }
}

/** A process's own name, from /proc. */
export function procComm(pid: number): string | null {
  try {
    return readFileSync(`/proc/${pid}/comm`, 'utf8').trim() || null
  } catch {
    return null
  }
}
