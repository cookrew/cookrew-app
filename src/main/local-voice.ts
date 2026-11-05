import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir, platform, tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

/**
 * THE LOCAL VOICE for spoken replies (renderer prompt/reply-voice.ts).
 *
 * Free and offline: Kokoro-82M v1.1-zh through sherpa-onnx, installed into
 * ~/.cookrew/tts by `node scripts/local-voice/install.mjs`. A Mandarin
 * female voice at a Doubao-like pace (about 5.2 characters a second), both
 * set in ~/.cookrew/tts/voice.json and read at every chunk.
 *
 * The model runs in its own node process (kokoro-server.cjs): a chunk is a
 * second or more of solid CPU, which would freeze this one, and Electron's
 * own node refuses the addon's audio buffers. It starts on the first chunk
 * and is let go after IDLE_MS quiet, since the model holds ~0.5 GB.
 *
 * Its WAV is re-encoded to AAC (afconvert) before it leaves: a 50 s chunk is
 * 2.4 MB as WAV and ~0.4 MB as AAC, which matters on the phone's relay.
 */

export const VOICE_HOME = path.join(homedir(), '.cookrew', 'tts')
/** One request's text: a chunk is 240 characters (shared/speakable.ts); this is the ceiling. */
export const SPEAK_REQUEST_MAX_CHARS = 600
const MODEL_FILE = path.join('kokoro-multi-lang-v1_1', 'model.onnx')
const RUNTIME_FILE = path.join('node_modules', 'sherpa-onnx-node', 'package.json')
const IDLE_MS = 10 * 60_000
const MAX_QUEUED = 6
/** Longest one chunk may take: a 600-character chunk at the slowest pace is well inside it. */
const CHUNK_TIMEOUT_MS = 90_000

/** A refusal with the HTTP status the phone's route answers it with. */
export class SpeakError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
    this.name = 'SpeakError'
  }
}

export interface SpokenAudio {
  readonly audio: Uint8Array
  /** audio/mp4 (AAC) normally; audio/wav when it could not be re-encoded. */
  readonly type: string
}

export type SpeakLang = 'zh' | 'en'

export interface LocalVoice {
  /** Whether the voice is installed on this Mac. */
  available: () => boolean
  /**
   * One chunk of text as audio. `lang` 'en' picks the English voice for a
   * reading with no Chinese in it. `signal` cancels a chunk not yet made.
   * Throws a SpeakError carrying the status to answer with.
   */
  speak: (text: string, signal?: AbortSignal, lang?: SpeakLang) => Promise<SpokenAudio>
  /** Start the voice process ahead of the first chunk (the model takes ~1.5 s to load). */
  warm: () => void
  /** End the voice process now (app quit). */
  stop: () => void
}

/** The node the installer recorded, if it is still there. */
export function voiceNode(home: string = VOICE_HOME): string | null {
  try {
    const { node } = JSON.parse(readFileSync(path.join(home, 'runtime.json'), 'utf8')) as { node?: unknown }
    return typeof node === 'string' && existsSync(node) ? node : null
  } catch {
    return null
  }
}

export function localVoiceInstalled(home: string = VOICE_HOME): boolean {
  return (
    existsSync(path.join(home, 'kokoro-server.cjs')) &&
    existsSync(path.join(home, MODEL_FILE)) &&
    existsSync(path.join(home, RUNTIME_FILE)) &&
    voiceNode(home) !== null
  )
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(command, args, (error) => (error ? reject(error) : resolve())))
}

/** WAV to AAC in an mp4 box with macOS's afconvert; the WAV itself where that fails. */
export async function encodeAac(wav: Uint8Array): Promise<SpokenAudio> {
  if (platform() !== 'darwin') return { audio: wav, type: 'audio/wav' }
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-voice-'))
  try {
    const input = path.join(dir, 'chunk.wav')
    const output = path.join(dir, 'chunk.m4a')
    writeFileSync(input, wav)
    await run('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '64000', input, output])
    return { audio: new Uint8Array(await readFile(output)), type: 'audio/mp4' }
  } catch {
    return { audio: wav, type: 'audio/wav' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

type VoiceProcess = Pick<ChildProcess, 'stdin' | 'stdout' | 'kill' | 'on'>

interface Pending {
  /** The process asked: its death fails its own jobs, never a newer process's. */
  readonly owner: VoiceProcess
  readonly resolve: (wav: Uint8Array) => void
  readonly reject: (error: SpeakError) => void
}

export interface LocalVoiceOptions {
  readonly home?: string
  readonly spawnImpl?: (node: string, script: string, home: string) => VoiceProcess
  readonly encode?: (wav: Uint8Array) => Promise<SpokenAudio>
  readonly idleMs?: number
  readonly maxQueued?: number
  readonly chunkTimeoutMs?: number
  readonly log?: (message: string) => void
}

const defaultSpawn = (node: string, script: string, home: string): VoiceProcess =>
  spawn(node, [script], { cwd: home, stdio: ['pipe', 'pipe', 'ignore'] })

export function createLocalVoice(options: LocalVoiceOptions = {}): LocalVoice {
  const home = options.home ?? VOICE_HOME
  const spawnImpl = options.spawnImpl ?? defaultSpawn
  const encode = options.encode ?? encodeAac
  const idleMs = options.idleMs ?? IDLE_MS
  const maxQueued = options.maxQueued ?? MAX_QUEUED
  const chunkTimeoutMs = options.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS
  const log = options.log ?? console.error
  const pending = new Map<string, Pending>()
  let child: VoiceProcess | null = null
  let idle: ReturnType<typeof setTimeout> | undefined

  const failJobsOf = (owner: VoiceProcess, error: SpeakError): void => {
    for (const [id, job] of [...pending]) {
      if (job.owner !== owner) continue
      pending.delete(id)
      job.reject(error)
    }
  }

  /** A process that is gone: forget it, and fail what it held. */
  const lost = (started: VoiceProcess, error: SpeakError): void => {
    if (child === started) child = null
    failJobsOf(started, error)
  }

  const settle = (message: { id?: unknown; ok?: unknown; wav?: unknown; error?: unknown }): void => {
    if (typeof message.id !== 'string') return
    const job = pending.get(message.id)
    if (!job) return
    pending.delete(message.id)
    if (message.ok === true && typeof message.wav === 'string') job.resolve(new Uint8Array(Buffer.from(message.wav, 'base64')))
    else job.reject(new SpeakError(`The local voice failed: ${typeof message.error === 'string' ? message.error : 'no audio'}`, 502))
    armIdle()
  }

  const stop = (): void => {
    clearTimeout(idle)
    const running = child
    child = null
    running?.kill()
  }

  function armIdle(): void {
    clearTimeout(idle)
    if (pending.size === 0) idle = setTimeout(stop, idleMs)
  }

  const processFor = (): VoiceProcess => {
    if (child) return child
    const node = voiceNode(home)
    if (!node) throw new SpeakError('The local voice is not installed', 503)
    const started = spawnImpl(node, path.join(home, 'kokoro-server.cjs'), home)
    child = started
    started.on('exit', (code) => {
      if ([...pending.values()].some((job) => job.owner === started)) log(`local voice: its process exited (${String(code)})`)
      lost(started, new SpeakError('The local voice stopped', 503))
    })
    // A spawn that fails emits 'error' and never 'exit'.
    started.on('error', (error) => {
      log(`local voice: ${error.message}`)
      lost(started, new SpeakError(`The local voice could not run: ${error.message}`, 503))
    })
    // A write racing the child's death is EPIPE: an uncaught one would quit the app.
    started.stdin?.on('error', (error) => log(`local voice: ${error.message}`))
    if (started.stdout) {
      readline.createInterface({ input: started.stdout }).on('line', (line) => {
        try {
          settle(JSON.parse(line))
        } catch {
          // not a frame: the voice's own chatter
        }
      })
    }
    return started
  }

  const synthesize = (text: string, lang: SpeakLang, signal?: AbortSignal): Promise<Uint8Array> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new SpeakError('Cancelled', 499))
      const voice = processFor()
      const id = randomUUID()
      const giveUp = (error: SpeakError): void => {
        if (!pending.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        if (!voice.stdin?.destroyed) voice.stdin?.write(`${JSON.stringify({ cancel: id })}\n`)
        reject(error)
        armIdle()
      }
      const onAbort = (): void => giveUp(new SpeakError('Cancelled', 499))
      const timer = setTimeout(() => giveUp(new SpeakError('The local voice took too long', 504)), chunkTimeoutMs)
      const done = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      pending.set(id, {
        owner: voice,
        resolve: (wav) => (done(), resolve(wav)),
        reject: (error) => (done(), reject(error))
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      clearTimeout(idle)
      voice.stdin?.write(`${JSON.stringify({ id, text, lang })}\n`)
    })

  return {
    available: () => localVoiceInstalled(home),
    warm: () => {
      if (child || !localVoiceInstalled(home)) return
      try {
        processFor()
        armIdle()
      } catch {
        // not installed after all: the first chunk will say so
      }
    },
    speak: async (text, signal, lang = 'zh') => {
      if (typeof text !== 'string' || text.trim() === '') throw new SpeakError('Nothing to say', 400)
      if (text.length > SPEAK_REQUEST_MAX_CHARS) throw new SpeakError(`At most ${SPEAK_REQUEST_MAX_CHARS} characters at a time`, 413)
      if (!localVoiceInstalled(home)) throw new SpeakError('The local voice is not installed', 503)
      if (pending.size >= maxQueued) throw new SpeakError('The voice is busy', 429)
      const wav = await synthesize(text.trim(), lang === 'en' ? 'en' : 'zh', signal)
      return encode(wav)
    },
    stop
  }
}
