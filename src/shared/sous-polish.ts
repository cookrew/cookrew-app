// Sous, turning thinking-aloud into the text you meant to type.
//
// Dictation into an agent is not transcription. The owner talks the way
// people think — fillers, false starts, "no wait, make it blue" — and what
// should land in the agent's box is the sentence they meant. Pure helpers
// here (prompt in, cleaned text out); the model call lives in main.
//
// The one rule that outranks quality: NEVER lose the words. Anything the
// model returns that is not plainly a cleaned version of the transcript —
// empty, our own instructions, a different language, twice as long — is
// refused, and the caller falls back to the raw transcript.

/** Below this a sentence is a command or a word; not worth a model round trip. */
export const POLISH_MIN_CHARS = 12
/**
 * Fillers and a false start are gone in a cleaned sentence, so it is shorter
 * — but not by more than half. Under that it is a summary, and a summary of a
 * request is a different request.
 */
export const MIN_KEPT_RATIO = 0.4

const CJK_RE = /\p{Script=Han}/u
const THINK_RE = /<think>[\s\S]*?(?:<\/think>|$)/gi
const LABEL_RE = /^(?:cleaned(?: text)?|text|output|结果|整理后|清理后)\s*[:：]\s*/i
const FENCE_RE = /^```[a-z]*\n([\s\S]*?)\n```$/

export function buildPolishSystem(): string {
  return [
    'You clean up dictated speech. The speaker was thinking aloud.',
    'Rewrite the transcript as the text they meant to type:',
    '- remove fillers (嗯, 那个, 呃, 就是说, um, uh, like, you know);',
    '- apply self-corrections: when they change their mind, keep only the final version;',
    '- fix punctuation and sentence breaks; use a list only if they enumerated;',
    '- keep their language, their wording and their tone — a Chinese transcript stays Chinese, never translate;',
    '- keep names, code, file paths, commands and numbers exactly as said;',
    '- never add, answer, shorten to a summary, or explain anything.',
    'Output only the cleaned text.'
  ].join('\n')
}

export function buildPolishPrompt(transcript: string): string {
  return `Transcript:\n${transcript.trim()}\n\nCleaned text:`
}

/**
 * Reduce the model's answer to the cleaned text, or null when it is not one.
 * `source` is the transcript, used to judge whether the answer is a version
 * of it rather than something else in its place.
 */
export function sanitizePolish(raw: string, source: string): string | null {
  let out = raw.replace(THINK_RE, '').replace(/\r\n/g, '\n').trim()
  const fenced = FENCE_RE.exec(out)
  if (fenced) out = fenced[1].trim()
  out = out.replace(LABEL_RE, '').trim()
  out = unwrap(out)
  if (out === '') return null
  if (looksLikeOurInstructions(out)) return null
  // Longer than the transcript by more than a little is content the speaker
  // never said; much shorter is a summary (a 3b model answered a whole
  // request with its last clause, measured); a different script is a
  // translation nobody asked for.
  const said = source.trim().length
  if (out.length > said * 2 + 40) return null
  if (out.length < said * MIN_KEPT_RATIO) return null
  if (CJK_RE.test(source) !== CJK_RE.test(out)) return null
  return out
}

/** Whether a transcript is worth the round trip at all. */
export function needsPolish(text: string): boolean {
  return text.trim().length >= POLISH_MIN_CHARS
}

const PAIRS: Array<[string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ['「', '」'],
  ["'", "'"]
]

function unwrap(text: string): string {
  for (const [open, close] of PAIRS) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      return text.slice(open.length, text.length - close.length).trim()
    }
  }
  return text
}

function looksLikeOurInstructions(text: string): boolean {
  const head = text.slice(0, 300).toLowerCase()
  return (
    head.startsWith('transcript:') ||
    head.includes('you clean up dictated') ||
    head.includes('output only the cleaned') ||
    head.includes('remove fillers')
  )
}
