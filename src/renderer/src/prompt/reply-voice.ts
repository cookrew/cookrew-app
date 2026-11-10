import { registerScopeState } from '../machine-scope'
import { cookrew } from '../api'
import { hasCjk, speakableText, speechChunks } from '../../../shared/speakable'

/**
 * THE VOICE THAT READS A REPLY (prompt/use-spoken-replies.ts).
 *
 * A reply is first turned into sentences a person would say and packed into
 * chunks (shared/speakable.ts). Where the Mac has the free local voice
 * installed (main/local-voice.ts), each chunk comes back as audio and plays
 * through ONE audio element, the next chunk fetched while this one plays.
 * Without it, or when a chunk fails, the rest is read by the browser's voice.
 *
 * One reading at a time: a new reply, or a stop, ends the one before it.
 */

type Listener = (reading: boolean) => void

let generation = 0
let reading = false
const listeners = new Set<Listener>()
let element: HTMLAudioElement | null = null
/** Ends whatever is sounding now: the playing chunk or the browser's queue. */
let stopCurrent: (() => void) | null = null
/** Chunks asked of the Mac and not yet answered, by request id: a stop cancels them. */
const asked = new Set<string>()
let asks = 0
/**
 * The browser voice's utterances, held until their reading settles: Chromium
 * drops `onend` for an utterance nothing references any more.
 */
let utterances: SpeechSynthesisUtterance[] = []
let primed = false

function setReading(next: boolean): void {
  if (reading === next) return
  reading = next
  for (const listener of listeners) listener(next)
}

export function isReading(): boolean {
  return reading
}

export function onReading(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function audioElement(): HTMLAudioElement | null {
  if (typeof Audio === 'undefined') return null
  element ??= new Audio()
  return element
}

/** 10 ms of silence as a WAV data URI, for priming the element. */
function silence(): string {
  const samples = 80
  const bytes = new Uint8Array(44 + samples * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (at: number, text: string): void => [...text].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true)
  view.setUint32(28, 16000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples * 2, true)
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`
}

/**
 * Called inside a tap. A phone browser (iOS) plays sound later, outside any
 * tap, only from an element a tap has played once, and speaks only once a
 * tap has spoken: this plays silence on the element every reply will use and
 * speaks an empty line. Never while a reply is sounding (it would cut it off).
 */
export function primeVoice(): void {
  if (reading) return
  primed = true
  const audio = audioElement()
  if (audio) {
    audio.src = silence()
    void audio.play().catch(() => undefined)
  }
  if (typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined') {
    speechSynthesis.speak(new SpeechSynthesisUtterance(''))
  }
}

/** Whether a tap has primed the voice since this page loaded. */
export function isPrimed(): boolean {
  return primed
}

function stopPlayback(): void {
  stopCurrent?.()
  stopCurrent = null
  for (const id of asked) cookrew().speakCancel?.(id)
  asked.clear()
  element?.pause()
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}

/** Announcements waiting for the reading in front of them to end. */
let queued: readonly string[] = []
const QUEUE_MAX = 6

/**
 * Say a short line (an agent finished, an agent needs you) without cutting
 * into what is being read: it waits its turn. The same line twice in the
 * queue is said once.
 */
export function announce(line: string): void {
  if (!reading) {
    void readAloud(line)
    return
  }
  if (queued.includes(line) || queued.length >= QUEUE_MAX) return
  queued = [...queued, line]
}

// A reply being read aloud is ONE machine's agent's, in that machine's voice:
// it stops, and what it had asked that machine for is cancelled, before the
// next machine is in scope.
registerScopeState('reply voice', () => stopReading(), 'stop')

/** Stop reading now, and drop the announcements waiting. Spoken replies stay on; the next reply is read. */
export function stopReading(): void {
  queued = []
  generation += 1
  stopPlayback()
  setReading(false)
}

/** Plays one chunk's audio to its end. False when it cannot play (the browser refused, the audio was bad). */
function playBlob(blob: Blob): Promise<boolean> {
  const audio = audioElement()
  if (!audio) return Promise.resolve(false)
  const url = URL.createObjectURL(blob)
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      audio.removeEventListener('ended', ended)
      audio.removeEventListener('error', failed)
      URL.revokeObjectURL(url)
      resolve(ok)
    }
    const ended = (): void => done(true)
    const failed = (): void => done(false)
    audio.addEventListener('ended', ended)
    audio.addEventListener('error', failed)
    stopCurrent = () => done(true)
    audio.src = url
    audio.play().catch(failed)
  })
}

/** The chunks in the Mac's voice. Answers the chunks it could not play, for the browser's voice. */
async function playLocal(chunks: readonly string[], gen: number): Promise<readonly string[]> {
  const fetchAudio = cookrew().speakAudio
  if (!fetchAudio) return chunks
  // One voice for the whole reading: the English one only when none of it is Chinese.
  const lang = chunks.some(hasCjk) ? 'zh' : 'en'
  // Async, so even a throw before the request is a rejection: the browser's voice reads the rest.
  const fetchChunk = async (i: number): Promise<Blob> => {
    asks += 1
    const id = `reply-${gen}-${asks}`
    asked.add(id)
    try {
      return await fetchAudio(chunks[i], lang, id)
    } finally {
      asked.delete(id)
    }
  }
  let next = fetchChunk(0)
  for (let i = 0; i < chunks.length; i += 1) {
    let blob: Blob
    try {
      blob = await next
    } catch {
      return gen === generation ? chunks.slice(i) : []
    }
    if (gen !== generation) return []
    if (i + 1 < chunks.length) {
      next = fetchChunk(i + 1)
      next.catch(() => undefined)
    }
    const played = await playBlob(blob)
    if (gen !== generation) return []
    if (!played) return chunks.slice(i)
  }
  return []
}

/** Longest a browser reading may take before it is called over: a slow voice, plus slack. */
export function browserDeadlineMs(chunks: readonly string[]): number {
  return chunks.reduce((ms, chunk) => ms + chunk.length * (hasCjk(chunk) ? 400 : 150), 5000)
}

/**
 * The browser's own voice, chunk by chunk (one long utterance stalls in
 * Chrome). A voice that never says it ended (an unprimed iOS page drops the
 * words silently) is called over at its deadline, so the button never stays lit.
 */
function playBrowser(chunks: readonly string[]): Promise<void> {
  if (typeof speechSynthesis === 'undefined' || chunks.length === 0) return Promise.resolve()
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (): void => {
      clearTimeout(timer)
      utterances = []
      resolve()
    }
    timer = setTimeout(done, browserDeadlineMs(chunks))
    stopCurrent = done
    utterances = chunks.map((chunk, i) => {
      const utterance = new SpeechSynthesisUtterance(chunk)
      if (hasCjk(chunk)) utterance.lang = 'zh-CN'
      if (i === chunks.length - 1) {
        utterance.onend = done
        utterance.onerror = done
      }
      return utterance
    })
    for (const utterance of utterances) speechSynthesis.speak(utterance)
  })
}

async function localVoiceAvailable(): Promise<boolean> {
  const api = cookrew()
  if (!api.speakAvailable || !api.speakAudio) return false
  return api.speakAvailable().catch(() => false)
}

/** Read `text` (a reply's markdown) aloud, ending any reading before it. */
export async function readAloud(text: string): Promise<void> {
  generation += 1
  const gen = generation
  stopPlayback()
  const chunks = speechChunks(speakableText(text))
  if (chunks.length === 0) {
    setReading(false)
    return
  }
  setReading(true)
  try {
    const rest = (await localVoiceAvailable()) && gen === generation ? await playLocal(chunks, gen) : chunks
    if (gen === generation && rest.length > 0) await playBrowser(rest)
  } finally {
    if (gen === generation) {
      stopCurrent = null
      setReading(false)
      // Ended on its own: the next announcement waiting is said.
      const [next, ...rest] = queued
      queued = rest
      if (next !== undefined) void readAloud(next)
    }
  }
}
