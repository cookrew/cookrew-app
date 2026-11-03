/**
 * Dictation into the prompt box, the parts with no DOM in them
 * (use-dictation.ts wires them up). One box, one ear: the Mac's on-device
 * recognizer when main offers it (cr-listen, hold ⌘), else the browser's Web
 * Speech API (the phone, the companion in a desktop browser). Electron has a
 * webkitSpeechRecognition too, but it has no speech service behind it, so the
 * Mac's own ear always wins.
 *
 * The third ear, 'phone': the phone records and the Mac hears the recording
 * (phone-recorder.ts → POST /api/listen → main/hear-file.ts). Chrome on
 * Android hands Web Speech to Google's recognition service, which is not
 * reachable from every network (owner, 2026-11-03: "Android voice input does
 * not work"), so Android records for the Mac by default, and any browser
 * whose recognizer turned out unreachable does from then on.
 */

export type Ear = 'mac' | 'web' | 'phone'

/** Set once a browser's own recognizer failed for want of its service. */
export const WEB_EAR_BROKEN_KEY = 'cookrew.dictation.webBroken'

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

/**
 * Which ear hears here. `phone`: this surface can record and the Mac can hear
 * it; `preferPhone`: the browser's own recognizer is not to be trusted here.
 */
export function pickEar(mac: boolean, web: boolean, phone = false, preferPhone = false): Ear | null {
  if (mac) return 'mac'
  if (phone && (preferPhone || !web)) return 'phone'
  return web ? 'web' : null
}

export function isAndroid(userAgent: string | undefined): boolean {
  return /\bAndroid\b/i.test(userAgent ?? '')
}

/**
 * A Web Speech error that means the recognizer's service is not there (not
 * that nobody spoke, nor that the mic was refused — recording would meet the
 * same refusal).
 */
export function webEarUnreachable(code: string | undefined): boolean {
  return code === 'network' || code === 'service-not-allowed' || code === 'language-not-supported'
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
