import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { LINUX_NO_XDOTOOL } from '../shared/remote-access'
import type { Gesture, ScreenPoints } from './vphone-input'

/**
 * THIS LINUX MACHINE'S HAND: X11 INPUT THROUGH XDOTOOL.
 *
 * The same closed vocabulary a Mac's hand takes (screen-device.ts · perform): a
 * tap, a drag, a scroll, a named key or a shortcut, typed text. Each gesture is
 * a list of xdotool argv arrays and nothing else. They are started with
 * execFile, never through a shell, and with this app's own environment, so
 * DISPLAY is the display this app draws on. Text is one argument after `--`:
 * xdotool's `type` reads everything after it as text, so nothing typed can
 * become an option, a chained xdotool command, or a shell word.
 *
 * WHERE A POINT LANDS. A card's frame is a picture of one display fitted to a
 * long side, so a point on it is a RATIO of that picture. The ratio is laid on
 * the display's own place on the X screen, and a point off the picture stops at
 * the display's edge rather than landing on the display beside it.
 *
 * WHAT IS REFUSED, IN WORDS. Wayland and a missing display, by name, ahead of
 * anything else (linux-screen.ts · linuxScreenRefusal). No xdotool is one
 * sentence naming the line that installs it. Gates above this one (the
 * machine switch, the card's grant, a served workspace) are the desk's
 * (remote-desk.ts); this only says whether the machine can take input at all.
 *
 * A DRY RUN (COOKREW_LINUX_INPUT_DRY_RUN=1, for tests and QA) runs the same
 * gates and the same mapping, logs each argv, and starts nothing. It never
 * writes what was typed, only how long it was.
 */

/** X screen pixels: where one display sits on the X screen, and its size. */
export interface DisplayArea {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** One xdotool run: its argv (without the binary) and how long it may take. */
export interface XdoCall {
  readonly argv: readonly string[]
  readonly timeoutMs: number
  /** A failure here is not the gesture's: asking a window manager that is not there (linux-windows.ts). */
  readonly optional?: boolean
}

/** Wheel that has not yet added up to a whole click, per axis. */
export interface WheelCarry {
  readonly x: number
  readonly y: number
}

export const NO_WHEEL: WheelCarry = { x: 0, y: 0 }

/** About one notch of a mouse wheel in a browser's pixels: a trackpad's small deltas add up to it. */
export const SCROLL_STEP_PX = 50
/** The most clicks one wheel event becomes: a flood of wheel is not a flood of clicks. */
export const MAX_SCROLL_CLICKS = 20
/** More than a person pastes into a screen; typing it would hold the hand for minutes. */
export const MAX_TYPE_CHARS = 4000
const TYPE_CHUNK_CHARS = 400
const TYPE_DELAY_MS = 12
const SCROLL_DELAY_MS = 15
const DRAG_STEPS = 8
const DRAG_MIN_SECONDS = 0.05
const DRAG_MAX_SECONDS = 2
const DRAG_SETTLE_SECONDS = 0.05
const BASE_TIMEOUT_MS = 5000
const LET_GO_TIMEOUT_MS = 2000
const SEARCH_DIRS = ['/usr/bin', '/usr/local/bin', '/bin', '/snap/bin']

/** X keysyms for the key names the gesture vocabulary speaks (vphone-input.ts, mac-bridge.ts · MAC_KEYS). */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  return: 'Return',
  delete: 'BackSpace',
  tab: 'Tab',
  escape: 'Escape',
  space: 'space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right'
}
/** A letter or digit is its own keysym: the keys a shortcut is made of. */
const PLAIN_KEY = /^[a-z0-9]$/

/** The keysym for a key name, or null when this vocabulary has no such key. */
export const xdotoolKey = (name: string): string | null => (Object.hasOwn(NAMED_KEYS, name) ? NAMED_KEYS[name] : PLAIN_KEY.test(name) ? name : null)

const finite = (value: number | string | undefined): number => {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** One axis: the ratio along the frame, laid on the display and kept inside it. */
function axis(value: number | string | undefined, size: number, origin: number, span: number): string {
  const ratio = size > 0 ? Math.min(Math.max(finite(value) / size, 0), 1) : 0
  return String(origin + Math.min(span - 1, Math.max(0, Math.floor(ratio * span))))
}

function at(frame: ScreenPoints, area: DisplayArea, x: number | string | undefined, y: number | string | undefined): [string, string] {
  return [axis(x, frame.width, area.x, area.width), axis(y, frame.height, area.y, area.height)]
}

const seconds = (n: number): string => String(Math.round(n * 1000) / 1000)

function drag(frame: ScreenPoints, area: DisplayArea, p: Gesture['params']): XdoCall {
  const [x1, y1] = at(frame, area, p.x1, p.y1)
  const span = Math.min(Math.max(finite(p.seconds), DRAG_MIN_SECONDS), DRAG_MAX_SECONDS)
  const fromX = finite(p.x1)
  const fromY = finite(p.y1)
  const steps = Array.from({ length: DRAG_STEPS }, (_, i) => {
    const t = (i + 1) / DRAG_STEPS
    const [x, y] = at(frame, area, fromX + (finite(p.x2) - fromX) * t, fromY + (finite(p.y2) - fromY) * t)
    return ['sleep', seconds(span / DRAG_STEPS), 'mousemove', x, y]
  })
  const argv = ['mousemove', x1, y1, 'mousedown', '1', ...steps.flat(), 'sleep', seconds(DRAG_SETTLE_SECONDS), 'mouseup', '1']
  return { argv, timeoutMs: BASE_TIMEOUT_MS + Math.ceil(span * 1000) }
}

/** Whole clicks out of the wheel so far; what is left over waits for the next scroll. */
function clicksOf(delta: number, carry: number): { readonly clicks: number; readonly carry: number } {
  const total = carry + delta
  const clicks = Math.trunc(total / SCROLL_STEP_PX)
  if (Math.abs(clicks) > MAX_SCROLL_CLICKS) return { clicks: Math.sign(clicks) * MAX_SCROLL_CLICKS, carry: 0 }
  return { clicks, carry: total - clicks * SCROLL_STEP_PX }
}

function scroll(frame: ScreenPoints, area: DisplayArea, p: Gesture['params'], wheel: WheelCarry): { calls: XdoCall[]; wheel: WheelCarry } {
  const [x, y] = at(frame, area, p.x, p.y)
  const vertical = clicksOf(finite(p.dy), wheel.y)
  const horizontal = clicksOf(finite(p.dx), wheel.x)
  // X11 has no wheel event: buttons 4 and 5 are up and down, 6 and 7 left and right.
  const press = (clicks: number, back: string, forward: string): XdoCall[] =>
    clicks === 0 ? [] : [{ argv: ['mousemove', x, y, 'click', '--repeat', String(Math.abs(clicks)), '--delay', String(SCROLL_DELAY_MS), clicks > 0 ? forward : back], timeoutMs: BASE_TIMEOUT_MS }]
  return { calls: [...press(vertical.clicks, '4', '5'), ...press(horizontal.clicks, '6', '7')], wheel: { x: horizontal.carry, y: vertical.carry } }
}

function key(p: Gesture['params']): XdoCall {
  const name = String(p.name)
  const sym = xdotoolKey(name)
  if (sym === null) throw new Error(`no '${name}' key on this machine`)
  // The viewer's shortcut modifier is ⌘ on a Mac and Ctrl here: the same shortcut either way.
  return { argv: ['key', '--clearmodifiers', p.mods === 'cmd' ? `ctrl+${sym}` : sym], timeoutMs: BASE_TIMEOUT_MS }
}

function type(text: string): XdoCall[] {
  // By code point, so a piece never ends in half a character.
  const chars = Array.from(text)
  if (chars.length > MAX_TYPE_CHARS) throw new Error(`That is too long to type here: ${chars.length} characters, and at most ${MAX_TYPE_CHARS} go at once`)
  const calls: XdoCall[] = []
  for (let start = 0; start < chars.length; start += TYPE_CHUNK_CHARS) {
    const piece = chars.slice(start, start + TYPE_CHUNK_CHARS)
    calls.push({ argv: ['type', '--clearmodifiers', '--delay', String(TYPE_DELAY_MS), '--', piece.join('')], timeoutMs: BASE_TIMEOUT_MS + piece.length * TYPE_DELAY_MS * 3 })
  }
  return calls
}

/** One gesture, in the frame's points, as the xdotool runs that do it on this display. */
export function xdotoolCalls(gesture: Gesture, frame: ScreenPoints, area: DisplayArea, wheel: WheelCarry): { readonly calls: readonly XdoCall[]; readonly wheel: WheelCarry } {
  const p = gesture.params
  switch (gesture.method) {
    case 'input.tap':
      return { calls: [{ argv: ['mousemove', ...at(frame, area, p.x, p.y), 'click', '1'], timeoutMs: BASE_TIMEOUT_MS }], wheel }
    case 'input.swipe':
      return { calls: [drag(frame, area, p)], wheel }
    case 'input.scroll':
      return scroll(frame, area, p, wheel)
    case 'input.key':
      return { calls: [key(p)], wheel }
    case 'input.type':
    case 'input.paste':
      return { calls: type(String(p.text ?? '')), wheel }
  }
}

/** Where a tool is: along PATH (absolute entries only), then where packages put it. */
export function findTool(name: string, env: { readonly PATH?: string }, exists: (file: string) => boolean = existsSync): string | null {
  const dirs = [...(env.PATH ?? '').split(path.delimiter).filter((dir) => path.isAbsolute(dir)), ...SEARCH_DIRS]
  for (const dir of dirs) {
    const file = path.join(dir, name)
    if (exists(file)) return file
  }
  return null
}

/** Where xdotool is. */
export const findXdotool = (env: { readonly PATH?: string }, exists: (file: string) => boolean = existsSync): string | null => findTool('xdotool', env, exists)

export const linuxInputDryRun = (env: Readonly<Record<string, string | undefined>>): boolean => env.COOKREW_LINUX_INPUT_DRY_RUN === '1'

export interface LinuxHandDeps {
  /** Wayland, or no display: said by name (linux-screen.ts · linuxScreenRefusal). */
  screenRefusal(): string | null
  /** The xdotool binary, or null when it is not installed. */
  find(): string | null
  run(bin: string, argv: readonly string[], timeoutMs: number): Promise<void>
  dryRun: boolean
  log(line: string): void
}

export interface LinuxHand {
  /** Why this machine cannot take input at all; null when it can. */
  refusal(): string | null
  /**
   * One gesture's calls, in order, one gesture at a time across every card (two cards'
   * drags must not cross). `stopped` is asked before each call: a long paste is many
   * calls, and Stop or the switch going off must cut it, not wait for it.
   */
  send(calls: readonly XdoCall[], stopped?: () => string | null): Promise<void>
  /**
   * One turn of the queue held for a gesture that must read X between its calls
   * (a window card: where the window is, whether it is in front). Nothing from
   * another card runs inside it, so what it read still holds when it presses.
   */
  exclusive<T>(work: (run: (calls: readonly XdoCall[], stopped?: () => string | null) => Promise<void>) => Promise<T>): Promise<T>
}

/** The argv as a log may show it: typed text becomes its length. */
function loggable(argv: readonly string[]): readonly string[] {
  const end = argv[0] === 'type' ? argv.indexOf('--') : -1
  if (end === -1) return argv
  return [...argv.slice(0, end + 1), ...argv.slice(end + 1).map((text) => `<${Array.from(text).length} characters>`)]
}

export function createLinuxHand(deps: LinuxHandDeps): LinuxHand {
  const refusal = (): string | null => deps.screenRefusal() ?? (deps.dryRun || deps.find() !== null ? null : LINUX_NO_XDOTOOL)
  let queue: Promise<void> = Promise.resolve()
  const run = async (calls: readonly XdoCall[], stopped: () => string | null): Promise<void> => {
    const refused = refusal()
    if (refused) throw new Error(refused)
    const bin = deps.dryRun ? null : deps.find()
    if (!deps.dryRun && bin === null) throw new Error(LINUX_NO_XDOTOOL)
    for (const call of calls) {
      const cut = stopped()
      if (cut) throw new Error(cut)
      if (bin === null) {
        deps.log(`[cookrew] linux input dry run, nothing started: xdotool ${JSON.stringify(loggable(call.argv))}`)
        continue
      }
      try {
        await deps.run(bin, call.argv, call.timeoutMs)
      } catch (error) {
        if (call.optional) continue
        // A drag cut short would leave the button down for whoever touches the machine next.
        if (call.argv.includes('mousedown')) await deps.run(bin, ['mouseup', '1'], LET_GO_TIMEOUT_MS).catch(() => undefined)
        throw error
      }
    }
  }
  const exclusive = <T>(work: (inTurn: (calls: readonly XdoCall[], stopped?: () => string | null) => Promise<void>) => Promise<T>): Promise<T> => {
    const turn = queue.then(() => work((calls, stopped = () => null) => run(calls, stopped)))
    queue = turn.then(
      () => undefined,
      () => undefined
    )
    return turn
  }
  return {
    refusal,
    send: (calls, stopped = () => null) => exclusive((inTurn) => inTurn(calls, stopped)),
    exclusive
  }
}

/** A read that is asked every frame, kept for a few seconds: an install is noticed, a disk walk per frame is not. */
export function cachedFor<T>(read: () => T, ms: number, now: () => number = Date.now): () => T {
  let held: { readonly value: T; readonly at: number } | null = null
  return () => {
    if (held && now() - held.at < ms) return held.value
    held = { value: read(), at: now() }
    return held.value
  }
}

const XDOTOOL_LOOKUP_MS = 5000

/** The real xdotool, with this app's own environment (so its DISPLAY), started without a shell. */
export function xdotoolRunner(env: NodeJS.ProcessEnv): LinuxHandDeps['run'] {
  return (bin, argv, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(bin, [...argv], { env: { ...env }, timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, _stdout, stderr) => {
        if (!error) return resolve()
        const said = String(stderr ?? '').trim().split('\n')[0]
        reject(new Error(`xdotool: ${said || error.message}`))
      })
    })
}

/** This machine's hand, from the app's environment. */
export function linuxHandFor(env: NodeJS.ProcessEnv, screenRefusal: () => string | null): LinuxHand {
  return createLinuxHand({
    screenRefusal,
    find: cachedFor(() => findXdotool(env), XDOTOOL_LOOKUP_MS),
    run: xdotoolRunner(env),
    dryRun: linuxInputDryRun(env),
    log: (line) => console.info(line)
  })
}
