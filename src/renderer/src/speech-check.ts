/**
 * TEMPORARY DIAGNOSTIC (owner, 2026-11-05; delete once the cause is known).
 *
 * Web Speech did nothing on the owner's Android, with no message. The prompt
 * box swallows `aborted` and `no-speech`, Chrome drops Android errors it has no
 * mapping for, and Android now skips this ear, so nothing says why. One tap in
 * ⋯ runs the recognizer twice (as the app does, then in zh-CN) and sends every
 * raw event to the phone's log (/api/beacon).
 */
import { apiPath } from './api-base'
import { authHeaders } from './auth-gate'
import { planeFetch } from './plane-fetch'

type Handler = ((event: Record<string, unknown>) => void) | null

export interface CheckRecognizer {
  lang?: string
  interimResults: boolean
  aborted?: boolean
  start: () => void
  abort: () => void
  onstart?: Handler
  onaudiostart?: Handler
  onsoundstart?: Handler
  onspeechstart?: Handler
  onspeechend?: Handler
  onsoundend?: Handler
  onaudioend?: Handler
  onnomatch?: Handler
  onresult?: Handler
  onerror?: Handler
  onend?: Handler
}

type Line = Record<string, unknown>

export interface SpeechCheckOptions {
  Ctor: (new () => CheckRecognizer) | null
  report: (line: Line) => void
  show: (text: string) => void
  /** How long each attempt listens before it is aborted. */
  listenMs?: number
  /** How long an aborted recognizer gets to say it ended. */
  endMs?: number
}

const ATTEMPTS: readonly { name: string; lang?: string }[] = [{ name: 'as-app' }, { name: 'zh-CN', lang: 'zh-CN' }]

const QUIET_EVENTS = ['start', 'audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend', 'nomatch'] as const

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type ResultList = ArrayLike<ArrayLike<{ transcript?: string }> & { isFinal?: boolean }>

function resultLine(event: Record<string, unknown>): Line {
  const results = Array.from((event.results ?? []) as ResultList)
  return {
    event: 'result',
    transcript: results.map((r) => r[0]?.transcript ?? '').join(''),
    isFinal: results.at(-1)?.isFinal === true
  }
}

/** One attempt: resolves when the recognizer ended, or went silent past its abort. */
function attempt(options: SpeechCheckOptions, Ctor: new () => CheckRecognizer, name: string, lang: string | undefined, say: (line: Line) => void): Promise<void> {
  return new Promise((resolve) => {
    const began = Date.now()
    const line = (fields: Line): void => say({ attempt: name, ms: Date.now() - began, ...fields })
    const recognizer = new Ctor()
    let ended = false
    let listen: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      if (ended) return
      ended = true
      clearTimeout(listen)
      resolve()
    }
    recognizer.interimResults = true
    if (lang) recognizer.lang = lang
    for (const name of QUIET_EVENTS) recognizer[`on${name}`] = () => line({ event: name })
    recognizer.onresult = (event) => line(resultLine(event))
    recognizer.onerror = (event) => line({ event: 'error', error: event.error, message: event.message })
    recognizer.onend = () => {
      line({ event: 'end' })
      done()
    }
    line({ event: 'begin', lang: lang ?? null })
    try {
      recognizer.start()
    } catch (error) {
      line({ event: 'start-threw', message: String(error) })
      done()
      return
    }
    listen = setTimeout(() => {
      line({ event: 'abort-sent' })
      recognizer.abort()
      setTimeout(() => {
        if (ended) return
        line({ event: 'no-end' })
        done()
      }, options.endMs ?? 3000)
    }, options.listenMs ?? 9000)
  })
}

export async function runSpeechCheck(options: SpeechCheckOptions): Promise<void> {
  let seq = 0
  const say = (line: Line): void => {
    options.report({ ...line, seq })
    seq += 1
    options.show(`${String(line.attempt ?? '')} ${String(line.event)} ${String(line.error ?? line.transcript ?? '')}`.trim())
  }
  if (!options.Ctor) {
    say({ event: 'no-recognizer' })
    return
  }
  for (const [i, { name, lang }] of ATTEMPTS.entries()) {
    options.show(`Say a sentence now (${i + 1} of ${ATTEMPTS.length})`)
    await attempt(options, options.Ctor, name, lang, say)
    await sleep(0)
  }
  options.show('Done. Tap here to close.')
}

/** What this browser says about itself before anything is started. */
async function environment(): Promise<Line> {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }
  const mic = await navigator.permissions?.query({ name: 'microphone' as PermissionName }).then((p) => p.state, (e: unknown) => `query failed: ${String(e)}`)
  return {
    event: 'env',
    userAgent: navigator.userAgent,
    languages: navigator.languages,
    docLang: document.documentElement.lang,
    secure: window.isSecureContext,
    standalone: window.matchMedia('(display-mode: standalone)').matches,
    speechRecognition: Boolean(w.SpeechRecognition),
    webkitSpeechRecognition: Boolean(w.webkitSpeechRecognition),
    mic
  }
}

function postLine(line: Line): void {
  void planeFetch(apiPath('/api/beacon'), {
    method: 'POST',
    headers: { ...authHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ speechCheck: true, at: Date.now(), ...line }),
    keepalive: true
  }).catch(() => undefined)
}

function overlay(): (text: string) => void {
  const box = document.createElement('div')
  box.setAttribute('role', 'status')
  box.style.cssText =
    'position:fixed;z-index:2147483647;left:8px;right:8px;top:8px;max-height:60vh;overflow:auto;padding:10px;border-radius:10px;background:#111;color:#eee;font:13px/1.4 monospace;white-space:pre-wrap'
  box.onclick = () => box.remove()
  document.body.append(box)
  return (text) => {
    box.textContent = `${box.textContent ?? ''}${box.textContent ? '\n' : ''}${text}`
    box.scrollTop = box.scrollHeight
  }
}

/** The ⋯ row's tap. */
export function startSpeechCheck(): void {
  const w = window as unknown as { SpeechRecognition?: new () => CheckRecognizer; webkitSpeechRecognition?: new () => CheckRecognizer }
  const show = overlay()
  void environment()
    .then(postLine, (e: unknown) => postLine({ event: 'env-failed', message: String(e) }))
    .then(() => runSpeechCheck({ Ctor: w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null, report: postLine, show }))
}
