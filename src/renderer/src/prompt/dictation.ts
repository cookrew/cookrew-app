/**
 * Dictation into the prompt box, the parts with no DOM in them
 * (use-dictation.ts wires them up). One box, one ear: the Mac's on-device
 * recognizer when main offers it (cr-listen, hold ⌘), else the browser's Web
 * Speech API (the phone, the companion in a desktop browser). Electron has a
 * webkitSpeechRecognition too, but it has no speech service behind it, so the
 * Mac's own ear always wins.
 */

export type Ear = 'mac' | 'web'

export type Recognizer = {
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

export type RecognizerCtor = new () => Recognizer

export function webRecognizer(scope: unknown): RecognizerCtor | null {
  const w = (scope ?? {}) as { SpeechRecognition?: RecognizerCtor; webkitSpeechRecognition?: RecognizerCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function pickEar(mac: boolean, web: boolean): Ear | null {
  if (mac) return 'mac'
  return web ? 'web' : null
}

/** What a Web Speech result list says so far. */
export function transcriptOf(results: ArrayLike<ArrayLike<{ transcript: string }>>): string {
  return Array.from(results, (r) => r[0]?.transcript ?? '').join('')
}

/** Heard words go after the draft, a space between; never over it. */
export function withHeard(draft: string, heard: string): string {
  const words = heard.trim()
  if (!words) return draft
  return draft.trim() ? `${draft.trimEnd()} ${words}` : words
}

/**
 * A Web Speech error worth telling the owner about, or null for the ones that
 * only mean "nothing was said" or "you stopped it".
 */
export function webErrorText(code: string | undefined): string | null {
  switch (code) {
    case undefined:
    case 'no-speech':
    case 'aborted':
      return null
    case 'not-allowed':
    case 'service-not-allowed':
      return 'The microphone is not allowed here.'
    case 'audio-capture':
      return 'No microphone was found.'
    case 'network':
      return 'Speech recognition is not reachable here.'
    default:
      return `Dictation stopped: ${code}.`
  }
}
