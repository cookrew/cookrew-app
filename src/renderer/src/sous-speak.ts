// Sous talking back on the desktop and the phone: the browser's own voice,
// in the language of the sentence. Short confirmations only ("okay, switching to
// cookrew dev"), so an utterance in flight is cut rather than queued — the
// owner has already said the next thing.

const CJK_RE = /\p{Script=Han}/u

export function speakSous(text: string): void {
  if (typeof speechSynthesis === 'undefined') return
  const gist = text.replace(/\s+/g, ' ').trim()
  if (!gist) return
  const utterance = new SpeechSynthesisUtterance(gist)
  utterance.lang = CJK_RE.test(gist) ? 'zh-CN' : 'en-US'
  speechSynthesis.cancel()
  speechSynthesis.speak(utterance)
}
