import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseEnvFile } from './service-grants'

/**
 * THE DOUBAO VOICE for spoken replies (renderer prompt/reply-voice.ts).
 *
 * Volcengine's Doubao speech synthesis, V3 HTTP unidirectional: one request
 * per chunk of text, an answer of JSON frames each carrying base64 mp3, the
 * last one code 20000000. The voice and its pace are Doubao's own: the 2.0
 * model, the Vivi voice, speech_rate 0 (the voice's natural speed). Each can
 * be changed in the env file.
 *
 * The key lives in ONE file, ~/.cookrew/doubao.env, readable only by the
 * owner, with no process.env fallback (the stripe-config.ts discipline). The
 * file is in owner-secrets.ts, so a served session cannot read it. It is read
 * at each use, so the owner adds it without a restart.
 *
 *   DOUBAO_TTS_API_KEY=...            new console: one API key
 *   DOUBAO_TTS_APP_ID=... + DOUBAO_TTS_ACCESS_KEY=...   old console: the pair
 *   DOUBAO_TTS_SPEAKER=zh_female_vv_uranus_bigtts      optional
 *   DOUBAO_TTS_RESOURCE_ID=seed-tts-2.0                optional (1.0 voices: seed-tts-1.0)
 *   DOUBAO_TTS_SPEECH_RATE=0                           optional, -50..100 (100 = 2x)
 */

export const DOUBAO_TTS_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional'
export const DOUBAO_DEFAULT_SPEAKER = 'zh_female_vv_uranus_bigtts'
export const DOUBAO_DEFAULT_RESOURCE = 'seed-tts-2.0'
/** One request's text: a chunk is 240 characters (shared/speakable.ts); this is the ceiling. */
export const SPEAK_REQUEST_MAX_CHARS = 600
const SUCCESS_CODE = 20000000
const TIMEOUT_MS = 20_000
const MAX_IN_FLIGHT = 3
/** Characters voiced per rolling minute: about four minutes of speech, so a looping client cannot run up the bill. */
const CHARS_PER_MINUTE = 6000
const MINUTE_MS = 60_000

export type DoubaoAuth = { readonly apiKey: string } | { readonly appId: string; readonly accessKey: string }

export interface DoubaoTtsConfig {
  readonly auth: DoubaoAuth
  readonly resourceId: string
  readonly speaker: string
  readonly speechRate: number
}

export interface DoubaoLoadOptions {
  /** Defaults to the owner's Cookrew data directory. Tests inject a temp dir. */
  readonly base?: string
  readonly log?: (message: string) => void
}

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

export function doubaoEnvPath(base: string = path.join(homedir(), '.cookrew')): string {
  return path.join(base, 'doubao.env')
}

function rateOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) ? Math.min(100, Math.max(-50, n)) : 0
}

function authOf(env: Record<string, string>): DoubaoAuth | null {
  const apiKey = env.DOUBAO_TTS_API_KEY?.trim()
  if (apiKey) return { apiKey }
  const appId = env.DOUBAO_TTS_APP_ID?.trim()
  const accessKey = env.DOUBAO_TTS_ACCESS_KEY?.trim()
  return appId && accessKey ? { appId, accessKey } : null
}

/** The Doubao voice's config, or null when it is not set up (the box then uses the browser's voice). */
export function loadDoubaoTts(options: DoubaoLoadOptions = {}): DoubaoTtsConfig | null {
  const file = doubaoEnvPath(options.base)
  const log = options.log ?? console.error
  try {
    if ((statSync(file).mode & 0o077) !== 0) {
      log(`doubao: ignoring ${file} - chmod 600 it`)
      return null
    }
    const env = parseEnvFile(readFileSync(file, 'utf8'))
    const auth = authOf(env)
    if (!auth) {
      log(`doubao: ${file} has no DOUBAO_TTS_API_KEY (or APP_ID + ACCESS_KEY pair)`)
      return null
    }
    return {
      auth,
      resourceId: env.DOUBAO_TTS_RESOURCE_ID?.trim() || DOUBAO_DEFAULT_RESOURCE,
      speaker: env.DOUBAO_TTS_SPEAKER?.trim() || DOUBAO_DEFAULT_SPEAKER,
      speechRate: rateOf(env.DOUBAO_TTS_SPEECH_RATE)
    }
  } catch (error) {
    // No file is the ordinary unconfigured state; anything else is named by path only.
    if (existsSync(file)) log(`doubao: cannot read ${file}`)
    void error
    return null
  }
}

export function doubaoRequest(
  config: DoubaoTtsConfig,
  text: string,
  requestId: string
): { url: string; init: { method: 'POST'; headers: Record<string, string>; body: string } } {
  const auth: Record<string, string> =
    'apiKey' in config.auth
      ? { 'X-Api-Key': config.auth.apiKey }
      : { 'X-Api-App-Id': config.auth.appId, 'X-Api-Access-Key': config.auth.accessKey }
  return {
    url: DOUBAO_TTS_URL,
    init: {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...auth,
        'X-Api-Resource-Id': config.resourceId,
        'X-Api-Request-Id': requestId
      },
      body: JSON.stringify({
        user: { uid: 'cookrew' },
        req_params: {
          text,
          speaker: config.speaker,
          audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: config.speechRate }
        }
      })
    }
  }
}

/**
 * Every top-level JSON object in `body`, whatever separates them: newlines
 * (chunked), `data:` frames (SSE), or nothing at all.
 */
function jsonObjects(body: string): unknown[] {
  const out: unknown[] = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"' && depth > 0) inString = true
    else if (c === '{') {
      if (depth === 0) start = i
      depth += 1
    } else if (c === '}' && depth > 0) {
      depth -= 1
      if (depth === 0) {
        try {
          out.push(JSON.parse(body.slice(start, i + 1)))
        } catch {
          // a torn frame: the frames around it still count
        }
      }
    }
  }
  return out
}

interface Frame {
  code?: unknown
  message?: unknown
  data?: unknown
  /** A refusal can come wrapped: {"header":{"code":45000010,"message":"Invalid X-Api-Key"}}. */
  header?: { code?: unknown; message?: unknown }
}

/** The mp3 in one answer, its frames joined; the server's refusal thrown with its code. */
export function audioOf(body: string): Buffer {
  const parts: Buffer[] = []
  for (const raw of jsonObjects(body)) {
    const frame = (raw ?? {}) as Frame
    const code = frame.code ?? frame.header?.code
    const message = frame.message ?? frame.header?.message
    const data = frame.data
    if (typeof code === 'number' && code !== 0 && code !== SUCCESS_CODE) {
      throw new SpeakError(`Doubao TTS ${code}: ${typeof message === 'string' ? message : 'refused'}`, 502)
    }
    if (typeof data === 'string' && data.length > 0) parts.push(Buffer.from(data, 'base64'))
  }
  if (parts.length === 0) throw new SpeakError('Doubao TTS returned no audio', 502)
  return Buffer.concat(parts)
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

function refusalOf(status: number, body: string, logId: string | null): string {
  let detail = body.slice(0, 200)
  try {
    const parsed = JSON.parse(body) as Frame & { error?: unknown }
    const named = parsed.message ?? parsed.header?.message ?? parsed.error
    const code = parsed.code ?? parsed.header?.code
    if (typeof named === 'string') detail = typeof code === 'number' ? `${named} (${code})` : named
  } catch {
    // not JSON: the start of the body is the detail
  }
  return `Doubao TTS HTTP ${status}: ${detail}${logId ? ` (logid ${logId})` : ''}`
}

export async function synthesizeDoubao(
  config: DoubaoTtsConfig,
  text: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<Buffer> {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const { url, init } = doubaoRequest(config, text, randomUUID())
  const timeout = AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  let response: Response
  let body: string
  try {
    // The answer streams: the timeout covers reading it too, so the read is inside.
    response = await fetchImpl(url, { ...init, signal })
    body = await response.text()
  } catch (error) {
    if (options.signal?.aborted) throw new SpeakError('Cancelled', 499)
    if (timeout.aborted) throw new SpeakError('Doubao TTS timed out', 504)
    throw new SpeakError(`Doubao TTS unreachable: ${error instanceof Error ? error.message : String(error)}`, 502)
  }
  if (!response.ok) throw new SpeakError(refusalOf(response.status, body, response.headers.get('x-tt-logid')), 502)
  return audioOf(body)
}

export interface DoubaoVoice {
  /** Whether a usable key is on disk now. */
  available: () => boolean
  /**
   * One chunk of text as mp3. Throws a SpeakError carrying the status to
   * answer with. `signal` cancels the request upstream: a stopped reading
   * frees its slot and is not billed for the rest.
   */
  speak: (text: string, signal?: AbortSignal) => Promise<Uint8Array>
}

export function createDoubaoVoice(
  options: DoubaoLoadOptions & { fetchImpl?: FetchLike; maxInFlight?: number; charsPerMinute?: number; now?: () => number } = {}
): DoubaoVoice {
  const charsPerMinute = options.charsPerMinute ?? CHARS_PER_MINUTE
  const maxInFlight = options.maxInFlight ?? MAX_IN_FLIGHT
  let inFlight = 0
  let spent: ReadonlyArray<{ readonly at: number; readonly chars: number }> = []
  const now = options.now ?? Date.now
  let lastLog = ''
  // The same complaint once, not on every reply.
  const log = (message: string): void => {
    if (message === lastLog) return
    lastLog = message
    ;(options.log ?? console.error)(message)
  }
  const load = (): DoubaoTtsConfig | null => loadDoubaoTts({ ...(options.base ? { base: options.base } : {}), log })
  return {
    available: () => load() !== null,
    speak: async (text, signal) => {
      if (typeof text !== 'string' || text.trim() === '') throw new SpeakError('Nothing to say', 400)
      if (text.length > SPEAK_REQUEST_MAX_CHARS) throw new SpeakError(`At most ${SPEAK_REQUEST_MAX_CHARS} characters at a time`, 413)
      const config = load()
      if (!config) throw new SpeakError('The Doubao voice is not set up on this Mac', 503)
      if (inFlight >= maxInFlight) throw new SpeakError('The voice is busy', 429)
      const at = now()
      spent = spent.filter((s) => at - s.at < MINUTE_MS)
      const used = spent.reduce((sum, s) => sum + s.chars, 0)
      if (used + text.length > charsPerMinute) throw new SpeakError('The voice has said enough for a minute', 429)
      spent = [...spent, { at, chars: text.length }]
      inFlight += 1
      try {
        return new Uint8Array(
          await synthesizeDoubao(config, text.trim(), {
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            ...(signal ? { signal } : {})
          })
        )
      } finally {
        inFlight -= 1
      }
    }
  }
}
