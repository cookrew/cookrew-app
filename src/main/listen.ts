// The Mac's ears, from main's side: one `cr-listen` child PER LOCALE per hold
// of the key, all on the same microphone.
//
// Why processes and not one process with two recognizers: measured 2026-09-06,
// two on-device recognizers inside one process are unreliable — one of them
// dies at once with 1110 "no speech detected", which one varies run to run —
// while two processes each with one recognizer answered identically in every
// run. macOS lets more than one process capture the microphone.
//
// The first locale is the PRIMARY: its partials are what the pill shows and
// its final is `text`. The others ride along as `alternates` (by locale) for
// the parser to try when the primary's names miss — a zh-CN ear hears
// "Conductor" as 双球, an en-US ear hears it exactly.
//
// Spawned on ⌘-down (after the beat), SIGINT'd on ⌘-up; each child answers
// with JSON lines (resources/cr-listen/cr-listen.m). A child that outlives
// its stop is killed, because a stuck helper must never hold the mic.

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { platform } from 'node:os'

export type ListenEvent =
  | { kind: 'ready'; locales: string[]; onDevice: boolean }
  | { kind: 'partial'; text: string }
  /** The primary transcript, plus what the other ears heard of the same audio. */
  | { kind: 'final'; text: string; alternates?: Record<string, string> }
  | { kind: 'error'; message: string }

/** One line of a helper's stdout → one event, or null for noise. */
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
    const locales = Array.isArray(o.locales) ? o.locales.filter((l): l is string => typeof l === 'string') : []
    return { kind: 'ready', locales, onDevice: o.onDevice === true }
  }
  if (typeof o.partial === 'string') return { kind: 'partial', text: o.partial }
  if (typeof o.final === 'string') {
    const alternates: Record<string, string> = {}
    if (o.alternates && typeof o.alternates === 'object') {
      for (const [locale, text] of Object.entries(o.alternates as Record<string, unknown>)) {
        if (typeof text === 'string' && text.trim() !== '') alternates[locale] = text
      }
    }
    return Object.keys(alternates).length > 0 ? { kind: 'final', text: o.final, alternates } : { kind: 'final', text: o.final }
  }
  if (typeof o.error === 'string') return { kind: 'error', message: o.error }
  return null
}

export interface ListenerOptions {
  binary: string
  /** Locales to listen in; the first is the primary whose partials are shown. */
  locales: () => string[]
  /** Names the recognizer should expect — the roster, read at each start. */
  hints: () => string[]
  maxSeconds?: number
  /** Injectable for tests; production spawns the real helper. */
  spawnFn?: typeof spawn
  /** How long after stop() a child may take to deliver its final. */
  graceMs?: number
  /** How long the alternates get after the primary settled. */
  settleMs?: number
}

interface Ear {
  locale: string
  child: ChildProcess
  buffer: string
  /** null until this ear has said its last word (final, error, or death). */
  final: string | null
}

export class MacListener {
  private ears: Ear[] = []
  private killTimer: NodeJS.Timeout | null = null
  private settleTimer: NodeJS.Timeout | null = null
  private stopped = false
  private done = false

  constructor(private readonly options: ListenerOptions) {}

  /** Only where the helper exists and the OS has the recognizer. */
  available(): boolean {
    return platform() === 'darwin' && existsSync(this.options.binary)
  }

  get listening(): boolean {
    return this.ears.length > 0
  }

  /**
   * Start listening; events arrive on `onEvent` until one final or one
   * error, after which every child is gone and a new hold may start again.
   */
  start(onEvent: (event: ListenEvent) => void): boolean {
    if (this.ears.length > 0) return false
    if (!this.available()) {
      onEvent({ kind: 'error', message: 'the speech helper is not built on this Mac (resources/cr-listen)' })
      return false
    }
    const spawnFn = this.options.spawnFn ?? spawn
    const locales = this.options.locales()
    const hints = this.options.hints()
    this.stopped = false
    this.done = false
    const ears: Ear[] = locales.map((locale) => {
      const args = ['--max-seconds', String(this.options.maxSeconds ?? 30), '--locale', locale]
      for (const hint of hints) args.push('--hint', hint)
      return { locale, child: spawnFn(this.options.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] }), buffer: '', final: null }
    })
    this.ears = ears
    const primary = ears[0]

    const finish = (): void => {
      if (this.done) return
      this.done = true
      const alternates: Record<string, string> = {}
      for (const ear of ears) {
        if (ear !== primary && ear.final && ear.final.trim() !== '') alternates[ear.locale] = ear.final
      }
      onEvent(
        Object.keys(alternates).length > 0
          ? { kind: 'final', text: primary.final ?? '', alternates }
          : { kind: 'final', text: primary.final ?? '' }
      )
      this.forgetAll()
    }
    const failed = (message: string): void => {
      if (this.done) return
      this.done = true
      onEvent({ kind: 'error', message })
      this.forgetAll()
    }
    // An ear has said its last word. The primary's word starts the clock on
    // the others; when every ear has spoken, or the clock runs out, the
    // final goes up with whatever the alternates managed.
    const settled = (ear: Ear, text: string): void => {
      if (ear.final !== null) return
      ear.final = text
      if (ears.every((e) => e.final !== null)) {
        finish()
        return
      }
      if (ear === primary && !this.settleTimer) {
        this.settleTimer = setTimeout(finish, this.options.settleMs ?? 1500)
      }
    }

    for (const ear of ears) {
      const { child } = ear
      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        ear.buffer += chunk
        const lines = ear.buffer.split('\n')
        ear.buffer = lines.pop() ?? ''
        for (const line of lines) {
          const event = parseListenLine(line)
          if (!event) continue
          if (event.kind === 'final') settled(ear, event.text)
          else if (event.kind === 'error') {
            // Only the primary's fault is the owner's problem; an alternate
            // that fails is just an alternate we do not have.
            if (ear === primary) failed(event.message)
            else settled(ear, '')
          } else if (ear === primary) onEvent(event)
        }
      })
      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk: string) => {
        // The helper's stderr is diagnostics only (meter, task errors).
        console.error(`cr-listen[${ear.locale}]: ${chunk.trim()}`)
      })
      child.on('error', (error) => {
        if (ear === primary) failed(`could not start the speech helper: ${error.message}`)
        else settled(ear, '')
      })
      child.on('exit', (code, signal) => {
        // A child that exits without a final said nothing; that is an empty
        // final, not an error — the owner held the key and did not speak. The
        // same for one we stopped that died to the signal (still waiting on
        // the permission dialog, say): silence, not a fault.
        const tail = parseListenLine(ear.buffer)
        ear.buffer = ''
        if (tail?.kind === 'final') settled(ear, tail.text)
        else if (tail?.kind === 'error' && ear === primary) failed(tail.message)
        else if (code === 0 || (this.stopped && signal !== null) || ear !== primary) settled(ear, '')
        else failed(`speech helper exited ${code ?? signal}`)
      })
    }
    return true
  }

  /** The key came up: let every helper settle on its final, then make sure they are gone. */
  stop(): void {
    if (this.ears.length === 0) return
    this.stopped = true
    const ears = this.ears
    for (const ear of ears) ear.child.kill('SIGINT')
    this.killTimer = setTimeout(() => {
      for (const ear of ears) {
        if (this.ears.includes(ear)) ear.child.kill('SIGKILL')
      }
    }, this.options.graceMs ?? 3000)
  }

  private forgetAll(): void {
    for (const ear of this.ears) {
      // Stragglers past the settle deadline: gone, not lingering on the mic.
      if (ear.final === null) ear.child.kill('SIGKILL')
    }
    this.ears = []
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
  }
}
