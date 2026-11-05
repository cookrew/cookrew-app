import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * THE MAC, AS A COMPUTER-USE SCREEN: WHAT IS ON IT, AND A HAND TO DRIVE IT.
 *
 * Both halves are JavaScript for Automation run by `osascript`, which ships
 * with every Mac — no helper binary to build, sign or notarise (this
 * machine's command-line tools cannot link Swift at all). macOS attributes
 * what osascript does to the app that started it, so Cookrew's own grants
 * are the ones that count: Screen Recording for window titles and capture,
 * Accessibility for input.
 *
 * LISTING is one short run per call: the displays and the on-screen windows,
 * front to back, with their bounds in global points (top-left origin, the
 * space CGEvent coordinates are in).
 *
 * INPUT is one long-lived run reading JSON lines on stdin and answering one
 * line each, so a click costs a pipe write, not a process start. Every line
 * is a closed operation — click, drag, scroll, key, type — with numbers and a
 * string; there is no path from the line to a script. Typing posts the text
 * one UTF-16 unit per key event (CGEventKeyboardSetUnicodeString), which
 * types any language without asking for Automation of System Events.
 *
 * THE HAND ASKS ABOUT THE LOCK ITSELF, on every operation, inside the helper:
 * a cached answer would leave a window where keys land in the lock screen's
 * password field, and remote unlock is out. A locked session gets no event.
 */

export interface MacDisplay {
  /** 1-based, main first — the numbering `screencapture -D` uses. */
  readonly index: number
  readonly id: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface MacWindow {
  readonly id: number
  /** The process that owns it: the picker leaves out Cookrew's own. */
  readonly pid?: number
  readonly app: string
  /** Empty without Screen Recording: macOS hides titles from apps that may not capture. */
  readonly title: string
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface MacScreens {
  readonly displays: readonly MacDisplay[]
  readonly windows: readonly MacWindow[]
}

const LIST_SCRIPT = `
ObjC.import('CoreGraphics'); ObjC.import('AppKit')
const displays = $.NSScreen.screens.js.map((s, i) => {
  const id = s.deviceDescription.objectForKey('NSScreenNumber').js
  const b = $.CGDisplayBounds(id)
  return { index: i + 1, id, x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height }
})
const raw = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0))) || []
const windows = raw.filter((w) => w.kCGWindowLayer === 0 && w.kCGWindowBounds && w.kCGWindowBounds.Width > 40 && w.kCGWindowBounds.Height > 40).map((w) => ({
  id: w.kCGWindowNumber, pid: w.kCGWindowOwnerPID, app: w.kCGWindowOwnerName || '', title: w.kCGWindowName || '',
  x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height
}))
JSON.stringify({ displays, windows })
`

/** One window by id, on screen or not: null when the window server no longer knows it. */
const WINDOW_SCRIPT = `
ObjC.import('CoreGraphics')
function run(argv) {
  const raw = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionIncludingWindow, Number(argv[0])))) || []
  return JSON.stringify(raw.length > 0 ? { app: raw[0].kCGWindowOwnerName || '' } : null)
}
`

/** Asks in a process started now: macOS fixes THIS app's Screen Recording answer at its launch. */
const SESSION_SCRIPT = `
ObjC.import('CoreGraphics'); ObjC.import('Foundation')
ObjC.bindFunction('CGSessionCopyCurrentDictionary', ['id', []])
ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []])
ObjC.bindFunction('CGDisplayIsAsleep', ['bool', ['unsigned int']])
ObjC.bindFunction('CGMainDisplayID', ['unsigned int', []])
const session = ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary()) || {}
JSON.stringify({ locked: session.CGSSessionScreenIsLocked === true || session.kCGSSessionOnConsoleKey === false, displayAsleep: $.CGDisplayIsAsleep($.CGMainDisplayID()), grant: $.CGPreflightScreenCaptureAccess() })
`

/**
 * Which app macOS holds responsible for this process. A permission belongs to
 * that app, and it follows the launch: started from a terminal it is the
 * terminal, whatever bundle the binary sits in. A child inherits it, so this
 * helper reads the same answer main would.
 */
const LISTED_APP_SCRIPT = `
ObjC.import('AppKit')
ObjC.bindFunction('getpid', ['int', []])
ObjC.bindFunction('responsibility_get_pid_responsible_for_pid', ['int', ['int']])
const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier($.responsibility_get_pid_responsible_for_pid($.getpid()))
app.isNil() || app.bundleURL.isNil() ? '' : app.bundleURL.path.js
`

export const MAC_INPUT_SCRIPT = `
ObjC.import('Foundation'); ObjC.import('CoreGraphics'); ObjC.import('AppKit')
ObjC.bindFunction('CGSessionCopyCurrentDictionary', ['id', []])
const locked = () => { const session = ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary()) || {}; return session.CGSSessionScreenIsLocked === true || session.kCGSSessionOnConsoleKey === false }
const COMMAND = 0x100000
const stdin = $.NSFileHandle.fileHandleWithStandardInput
const stdout = $.NSFileHandle.fileHandleWithStandardOutput
const say = (s) => stdout.writeData($(s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding))
let dry = false
const post = (ev) => { if (!dry) $.CGEventPost(0, ev) }
const mouse = (type, x, y) => { const ev = $.CGEventCreateMouseEvent(null, type, { x, y }, 0); $.CGEventSetIntegerValueField(ev, 1, 1); post(ev) }
const num = (v) => { if (typeof v !== 'number' || !isFinite(v)) throw new Error('bad number'); return v }
function run(op) {
  dry = op.dry === true
  if (op.op === 'ping') return
  if (locked()) throw new Error('the screen is locked')
  switch (op.op) {
    case 'click': { const x = num(op.x), y = num(op.y); mouse(5, x, y); mouse(1, x, y); delay(0.02); mouse(2, x, y); return }
    case 'drag': {
      const x1 = num(op.x1), y1 = num(op.y1), x2 = num(op.x2), y2 = num(op.y2), steps = 12
      const pause = Math.min(Math.max(num(op.ms), 60), 2000) / 1000 / steps
      mouse(5, x1, y1); mouse(1, x1, y1)
      for (let i = 1; i <= steps; i++) { mouse(6, x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps); delay(pause) }
      mouse(2, x2, y2); return
    }
    case 'scroll': { mouse(5, num(op.x), num(op.y)); post($.CGEventCreateScrollWheelEvent2(null, 0, 2, -Math.round(num(op.dy)), -Math.round(num(op.dx)), 0)); return }
    case 'key': {
      const code = num(op.code)
      for (const down of [true, false]) { const ev = $.CGEventCreateKeyboardEvent(null, code, down); if (op.cmd === true) $.CGEventSetFlags(ev, COMMAND); post(ev) }
      return
    }
    case 'type': {
      if (typeof op.text !== 'string' || op.text.length > 2000) throw new Error('bad text')
      for (let i = 0; i < op.text.length; i++) {
        const unit = Ref('unsigned short'); unit[0] = op.text.charCodeAt(i)
        for (const down of [true, false]) { const ev = $.CGEventCreateKeyboardEvent(null, 0, down); $.CGEventKeyboardSetUnicodeString(ev, 1, unit); post(ev) }
      }
      return
    }
    default: throw new Error('unknown op')
  }
}
let pending = ''
for (;;) {
  const data = stdin.availableData
  if (data.length === 0) break
  pending += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js
  let nl
  while ((nl = pending.indexOf('\\n')) >= 0) {
    const line = pending.slice(0, nl); pending = pending.slice(nl + 1)
    try { run(JSON.parse(line)); say('ok') } catch (e) { say('err ' + String(e).slice(0, 200)) }
  }
}
`

const OSASCRIPT = '/usr/bin/osascript'

export interface MacSessionFacts {
  readonly locked: boolean
  readonly displayAsleep: boolean
  readonly grant: boolean | null
}

/** The lock, the main display and a fresh answer about Screen Recording, in one short run. Rejects when it cannot tell. */
export function readMacSession(timeoutMs = 4000): Promise<MacSessionFacts> {
  return new Promise((resolve, reject) => {
    execFile(OSASCRIPT, ['-l', 'JavaScript', '-e', SESSION_SCRIPT], { timeout: timeoutMs }, (error, stdout) => {
      if (error) return reject(new Error(`could not read this Mac's session: ${error.message.split('\n')[0]}`))
      try {
        const facts = JSON.parse(String(stdout)) as Record<string, unknown>
        resolve({ locked: facts.locked === true, displayAsleep: facts.displayAsleep === true, grant: typeof facts.grant === 'boolean' ? facts.grant : null })
      } catch {
        reject(new Error("could not read the answer about this Mac's session"))
      }
    })
  })
}

/** The bundle System Settings files this process's permissions under. Null when nothing can say: the name falls back on the binary's own bundle. */
export function readMacListedApp(timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(OSASCRIPT, ['-l', 'JavaScript', '-e', LISTED_APP_SCRIPT], { timeout: timeoutMs }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null)
    })
  })
}

export function listMacScreens(timeoutMs = 5000): Promise<MacScreens> {
  return new Promise((resolve, reject) => {
    execFile(OSASCRIPT, ['-l', 'JavaScript', '-e', LIST_SCRIPT], { timeout: timeoutMs }, (error, stdout) => {
      if (error) return reject(new Error(`could not list this Mac's windows: ${error.message.split('\n')[0]}`))
      try {
        resolve(JSON.parse(String(stdout)) as MacScreens)
      } catch {
        reject(new Error("could not read this Mac's window list"))
      }
    })
  })
}

/** The app holding this window id, wherever the window is; null when it has closed. A failed lookup rejects: it proves nothing. */
export function macWindowAlive(id: number, timeoutMs = 5000): Promise<{ readonly app: string } | null> {
  return new Promise((resolve, reject) => {
    execFile(OSASCRIPT, ['-l', 'JavaScript', '-e', WINDOW_SCRIPT, String(id)], { timeout: timeoutMs }, (error, stdout) => {
      if (error) return reject(new Error(`could not look up this window: ${error.message.split('\n')[0]}`))
      try {
        resolve(JSON.parse(String(stdout)) as { app: string } | null)
      } catch {
        reject(new Error('could not read the answer about this window'))
      }
    })
  })
}

/** Mac virtual key codes for the key names the gesture vocabulary speaks. */
const MAC_KEYS: Record<string, number> = {
  return: 36,
  delete: 51,
  tab: 48,
  escape: 53,
  space: 49,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  // ANSI positions, for the chords a viewer sends (⌘C, ⌘V and the rest).
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  '1': 18, '2': 19, '3': 20, '4': 21, '6': 22, '5': 23, '9': 25, '7': 26, '8': 28, '0': 29,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46
}

export const macKeyCode = (name: string): number | null => MAC_KEYS[name] ?? null

export type MacOp =
  | { op: 'ping' }
  | { op: 'click'; x: number; y: number }
  | { op: 'drag'; x1: number; y1: number; x2: number; y2: number; ms: number }
  | { op: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { op: 'key'; code: number; cmd?: true }
  | { op: 'type'; text: string }

interface Waiter {
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The long-lived input hand. Started on first use, restarted after it dies,
 * answers in order. `dry` builds every event and posts none — for tests that
 * must never move the owner's mouse.
 */
export class MacInput {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly waiters: Waiter[] = []
  private buffered = ''

  constructor(
    private readonly options: { dry?: boolean; timeoutMs?: number; spawnHelper?: () => ChildProcessWithoutNullStreams } = {}
  ) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) return this.child
    const child = (this.options.spawnHelper ?? (() => spawn(OSASCRIPT, ['-l', 'JavaScript', '-e', MAC_INPUT_SCRIPT])))()
    this.buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => this.onOutput(chunk))
    child.on('exit', () => {
      if (this.child === child) this.child = null
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('the input helper stopped'))
      }
    })
    child.on('error', () => undefined)
    // A write to a helper that just died is EPIPE on stdin; without a
    // listener that is an uncaught exception in main. The exit handler
    // already failed the waiters.
    child.stdin.on('error', () => undefined)
    child.stderr.on('data', () => undefined)
    this.child = child
    return child
  }

  private onOutput(chunk: string): void {
    this.buffered += chunk
    let nl: number
    while ((nl = this.buffered.indexOf('\n')) >= 0) {
      const line = this.buffered.slice(0, nl)
      this.buffered = this.buffered.slice(nl + 1)
      const waiter = this.waiters.shift()
      if (!waiter) continue
      clearTimeout(waiter.timer)
      if (line === 'ok') waiter.resolve()
      else waiter.reject(new Error(line.replace(/^err\s*/, 'the Mac refused the input: ')))
    }
  }

  send(op: MacOp): Promise<void> {
    const child = this.ensure()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.findIndex((w) => w.timer === timer)
        if (at >= 0) this.waiters.splice(at, 1)
        reject(new Error('the Mac did not take the input in time'))
        // Out of step now: answers would pair with the wrong waiter.
        child.kill()
      }, this.options.timeoutMs ?? 8000)
      this.waiters.push({ resolve, reject, timer })
      child.stdin.write(`${JSON.stringify(this.options.dry ? { ...op, dry: true } : op)}\n`)
    })
  }

  close(): void {
    this.child?.stdin.end()
    this.child?.kill()
    this.child = null
  }
}
