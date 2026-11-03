// The Mac's ear for a recording made somewhere else — the phone.
//
// Chrome on Android hands Web Speech to Google's recognition service, which
// is not reachable from every network (2026-11-03: the owner's Android mic
// did nothing). The phone records instead and the Mac hears the recording
// with the same on-device recognizers ⌘-hold uses: one `cr-listen --file`
// child per locale, the first the primary, the rest its alternates.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import { platform, tmpdir } from 'node:os'
import path from 'node:path'
import { parseListenLine } from './listen'

export interface Heard {
  text: string
  /** What the other locales heard of the same audio, by locale; empty readings left out. */
  alternates: Record<string, string>
}

export interface HearFileOptions {
  binary: string
  locales: () => string[]
  hints: () => string[]
  /** A recording longer than this is refused before any helper starts. */
  maxBytes?: number
  /**
   * Hard stop per helper, on top of the recording's own length (the helper
   * answers with what it heard so far when it runs out).
   */
  maxSeconds?: number
  /** How long the alternates get once the primary has its words (as the live ear). */
  settleMs?: number
  /** Injectable for tests; production spawns the real helper. */
  spawnFn?: typeof spawn
  /** Where the recording lands for the helper to read. */
  dir?: string
}

/** 16 kHz mono 16-bit is 32 KB a second: four megabytes is two minutes. */
export const HEAR_MAX_BYTES = 4 * 1024 * 1024

export function hearAvailable(options: Pick<HearFileOptions, 'binary'>): boolean {
  return platform() === 'darwin' && existsSync(options.binary)
}

/** 16 kHz mono 16-bit: the seconds a WAV of this size holds (a little more for other formats). */
export function recordingSeconds(bytes: number): number {
  return Math.ceil(bytes / 32000)
}

/** One helper's last word: its final, '' for silence, or an Error for a fault. */
function hearOne(options: HearFileOptions, file: string, locale: string, hints: string[], seconds: number, kills: Array<() => void>): Promise<string> {
  const spawnFn = options.spawnFn ?? spawn
  const args = ['--max-seconds', String(seconds), '--locale', locale, '--file', file]
  for (const hint of hints) args.push('--hint', hint)
  return new Promise((resolve, reject) => {
    const child = spawnFn(options.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    kills.push(() => child.kill('SIGKILL'))
    let buffer = ''
    let settled = false
    const settle = (outcome: string | Error): void => {
      if (settled) return
      settled = true
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    const read = (line: string): void => {
      const event = parseListenLine(line)
      if (event?.kind === 'final') settle(event.text)
      else if (event?.kind === 'error') settle(new Error(event.message))
    }
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      lines.forEach(read)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => console.error(`cr-listen[${locale}] file: ${chunk.trim()}`))
    child.on('error', (error) => settle(new Error(`could not start the speech helper: ${error.message}`)))
    // 'close', not 'exit': exit can come before the stdout chunk that holds
    // the final (the helper prints it and exits at once); close waits for it.
    child.on('close', (code, signal) => {
      read(buffer)
      // Exit without a final: silence when clean, a fault otherwise.
      settle(code === 0 ? '' : new Error(`speech helper exited ${code ?? signal}`))
    })
  })
}

/**
 * Hear one recording (any format AVAudioFile reads: WAV, CAF, M4A…). Only the
 * primary's fault fails the whole; an alternate that fails is one we do not have.
 */
export async function hearRecording(options: HearFileOptions, bytes: Uint8Array): Promise<Heard> {
  if (!hearAvailable(options)) throw new Error('the speech helper is not built on this Mac (resources/cr-listen)')
  if (bytes.length === 0) throw new Error('the recording is empty')
  if (bytes.length > (options.maxBytes ?? HEAR_MAX_BYTES)) throw new Error('the recording is too long to hear')
  const [primary, ...others] = options.locales()
  if (!primary) throw new Error('no locale to hear in')
  const hints = options.hints()
  const file = path.join(options.dir ?? tmpdir(), `cookrew-hear-${randomUUID()}.wav`)
  await fs.writeFile(file, bytes, { mode: 0o600 })
  const kills: Array<() => void> = []
  const seconds = recordingSeconds(bytes.length) + (options.maxSeconds ?? 30)
  const [first, ...alternates] = [primary, ...others].map((locale) => hearOne(options, file, locale, hints, seconds, kills))
  // An alternate's fault is only an alternate we do not have, handled from the
  // start so it is never an unhandled rejection while the primary still hears.
  const rest = alternates.map((ear) => ear.catch(() => null))
  try {
    const text = await first
    // The primary has its words: the alternates get a beat more, not as long
    // as they like (an en-US ear on Chinese audio can take seconds longer).
    let beat: NodeJS.Timeout | undefined
    const late = new Promise<null>((resolve) => {
      beat = setTimeout(() => resolve(null), options.settleMs ?? 1500)
    })
    const heard = await Promise.all(rest.map((ear) => Promise.race([ear, late])))
    clearTimeout(beat)
    const alternates = Object.fromEntries(
      others.flatMap((locale, i) => {
        const words = heard[i]
        return typeof words === 'string' && words.trim() !== '' ? [[locale, words]] : []
      })
    )
    return { text, alternates }
  } finally {
    // Stragglers past the beat, or ears still going when the primary failed.
    kills.forEach((kill) => kill())
    await fs.rm(file, { force: true })
  }
}
