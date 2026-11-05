/**
 * Dictation into the prompt box, the parts with no DOM in them
 * (use-dictation.ts wires them up). One box, one ear: the Mac's on-device
 * recognizer when main offers it (cr-listen, hold ⌘), else the browser's Web
 * Speech API (the phone, the companion in a desktop browser). Electron has a
 * webkitSpeechRecognition too, but it has no speech service behind it, so the
 * Mac's own ear always wins.
 *
 * The third ear, 'phone': the phone records and the Mac hears the recording
 * (phone-recorder.ts → POST /api/listen → main/hear-file.ts). Any browser whose
 * recognizer turned out unreachable does from then on; until then a browser
 * hears for itself, Android included (owner, 2026-11-05).
 *
 * What the owner's Android first met (2026-11-03, measured 2026-11-05) was no
 * missing service: with no `lang` the recognizer followed the phone's en-GB,
 * and Chinese speech ended in a bare `nomatch` with no error. So the browser's
 * ear hears in the Mac's language, and says when it caught nothing. Android
 * listens through pauses (`continuous`) until the mic is tapped; other browsers
 * keep ending at the pause, as they always have.
 */

export type Ear = 'mac' | 'web' | 'phone'

/** Set once a browser's own recognizer failed for want of its service. */
export const WEB_EAR_BROKEN_KEY = 'cookrew.dictation.webBroken'

/** main/sous-voice-config.ts · DEFAULT_VOICE_LOCALE, for a Mac too old to say its own. */
const DEFAULT_EAR_LANG = 'zh-CN'

export type Recognizer = {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onerror: ((event: { error?: string }) => void) | null
  onnomatch: (() => void) | null
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

/** The stored WEB_EAR_BROKEN_KEY: a browser leaves its own ear only once that ear failed. */
export function preferPhoneEar(stored: string | null | undefined): boolean {
  return stored === '1'
}

/**
 * What the box's placeholder says while an ear is open, or null to leave it be.
 * IN the box: a note of its own took a row on a phone and moved every button
 * under the owner's thumb (owner, 2026-11-03).
 */
export function earSays(ear: Ear | null, phase: 'idle' | 'hearing' | 'closing', heard: string): string | null {
  if (phase === 'idle') return null
  if (ear === 'phone') return phase === 'hearing' ? '● Recording… tap the mic to finish' : 'The Mac is listening…'
  if (phase === 'hearing') return 'Listening… tap the mic to finish'
  return ear === 'web' && heard.trim() ? `… ${heard.trim()}` : null
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

/** The language the browser's ear hears in: the Mac's, never the browser's own. */
export function webLang(macLocale: string | null | undefined): string {
  return macLocale?.trim() || DEFAULT_EAR_LANG
}

/** What the box says when the browser's ear closed: its error, or that it caught nothing. */
export function webEndError(failed: string | null, missed: boolean, said: string): string | null {
  if (failed) return failed
  return missed && !said.trim() ? 'Nothing was recognized: try again.' : null
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
