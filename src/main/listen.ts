// The Mac's ear, from main's side: one `cr-listen` child per hold of the key.
//
// Spawned on ⌘-down (after the beat), SIGINT'd on ⌘-up; it answers with JSON
// lines (resources/cr-listen/cr-listen.m) which are parsed here and handed
// up as events. One child at a time — a second start while one is running is
// ignored rather than doubling the microphone — and a child that outlives its
// hard stop is killed, because a stuck helper must never hold the mic.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'

export type ListenEvent =
  | { kind: 'ready'; locale: string; onDevice: boolean }
  | { kind: 'partial'; text: string }
  | { kind: 'final'; text: string }
  | { kind: 'error'; message: string }

/** One line of the helper's stdout → one event, or null for noise. */
export function parseListenLine(line: string): ListenEvent | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.ready === true) {
    return {
      kind: 'ready',
      locale: typeof o.locale === 'string' ? o.locale : '',
      onDevice: o.onDevice === true
    }
  }
  if (typeof o.partial === 'string') return { kind: 'partial', text: o.partial }
  if (typeof o.final === 'string') return { kind: 'final', text: o.final }
  if (typeof o.error === 'string') return { kind: 'error', message: o.error }
  return null
}

export interface ListenerOptions {
  binary: string
  locale: () => string
  /** Names the recognizer should expect — the roster, read at each start. */
  hints: () => string[]
  maxSeconds?: number
  /** Injectable for tests; production spawns the real helper. */
  spawnFn?: typeof spawn
  /** How long after stop() a child may take to deliver its final. */
  graceMs?: number
}

export class MacListener {
  private child: ChildProcess | null = null
  private killTimer: NodeJS.Timeout | null = null
  /** Children we asked to stop — their death by signal is not news. */
  private readonly stopped = new WeakSet<ChildProcess>()

  constructor(private readonly options: ListenerOptions) {}

  /** Only where the helper exists and the OS has the recognizer. */
  available(): boolean {
    return platform() === 'darwin' && existsSync(this.options.binary)
  }

  get listening(): boolean {
    return this.child !== null
  }

  /**
   * Start listening; events arrive on `onEvent` until a final or an error,
   * after which the child is gone and a new hold may start another.
   */
  start(onEvent: (event: ListenEvent) => void): boolean {
    if (this.child) return false
    if (!this.available()) {
      onEvent({ kind: 'error', message: 'the speech helper is not built on this Mac (resources/cr-listen)' })
      return false
    }
    const spawnFn = this.options.spawnFn ?? spawn
    const args = ['--locale', this.options.locale(), '--max-seconds', String(this.options.maxSeconds ?? 30)]
    for (const hint of this.options.hints()) args.push('--hint', hint)
    const child = spawnFn(this.options.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    let buffer = ''
    let settled = false
    const settle = (event: ListenEvent): void => {
      if (settled) return
      settled = true
      onEvent(event)
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseListenLine(line)
        if (!event) continue
        if (event.kind === 'final' || event.kind === 'error') settle(event)
        else onEvent(event)
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      // The helper's stderr is diagnostics only (meter, task errors); it is
      // worth a log line, never a user-facing event.
      console.error(`cr-listen: ${chunk.trim()}`)
    })
    child.on('error', (error) => {
      settle({ kind: 'error', message: `could not start the speech helper: ${error.message}` })
      this.forget(child)
    })
    child.on('exit', (code, signal) => {
      // A child that exits without a final said nothing; that is an empty
      // final, not an error — the owner held the key and did not speak. The
      // same for one we stopped ourselves and that died to the signal (still
      // waiting on the permission dialog, say): silence, not a fault.
      const tail = parseListenLine(buffer)
      if (tail && (tail.kind === 'final' || tail.kind === 'error')) settle(tail)
      else if (code === 0 || (this.stopped.has(child) && signal !== null)) settle({ kind: 'final', text: '' })
      else settle({ kind: 'error', message: `speech helper exited ${code ?? signal}` })
      this.forget(child)
    })
    return true
  }

  /** The key came up: let the helper settle on its final, then make sure it is gone. */
  stop(): void {
    const child = this.child
    if (!child) return
    this.stopped.add(child)
    child.kill('SIGINT')
    this.killTimer = setTimeout(() => {
      if (this.child === child) child.kill('SIGKILL')
    }, this.options.graceMs ?? 3000)
  }

  private forget(child: ChildProcess): void {
    if (this.child !== child) return
    this.child = null
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
  }
}
