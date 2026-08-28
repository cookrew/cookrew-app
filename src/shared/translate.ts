// Translating a checkpoint body with Sous — the pure half.
//
// Everything here is decision-making about TEXT: which languages we offer, how
// a long reply is cut into pieces a small local model can actually finish, what
// we ask it, and which of its answers we are willing to show. The network call
// lives in main/sous.ts; none of it is needed to test any of this.

/** A language the menu can target. `label` is what the model is asked for. */
export interface TranslateLanguage {
  /** BCP-47-ish tag, used as a stable id in state and props. */
  code: string
  /** Endonym, for the menu — a reader looking for their language scans for it. */
  name: string
  /** English name, for the prompt — small models follow it far more reliably. */
  label: string
}

export const TRANSLATE_LANGUAGES: readonly TranslateLanguage[] = [
  { code: 'en', name: 'English', label: 'English' },
  { code: 'zh-Hans', name: '简体中文', label: 'Simplified Chinese' },
  { code: 'zh-Hant', name: '繁體中文', label: 'Traditional Chinese' },
  { code: 'ja', name: '日本語', label: 'Japanese' },
  { code: 'ko', name: '한국어', label: 'Korean' },
  { code: 'vi', name: 'Tiếng Việt', label: 'Vietnamese' },
  { code: 'th', name: 'ไทย', label: 'Thai' },
  { code: 'id', name: 'Bahasa Indonesia', label: 'Indonesian' },
  { code: 'hi', name: 'हिन्दी', label: 'Hindi' },
  { code: 'ar', name: 'العربية', label: 'Arabic' },
  { code: 'es', name: 'Español', label: 'Spanish' },
  { code: 'pt', name: 'Português', label: 'Portuguese' },
  { code: 'fr', name: 'Français', label: 'French' },
  { code: 'de', name: 'Deutsch', label: 'German' },
  { code: 'ru', name: 'Русский', label: 'Russian' }
]

export function languageByCode(code: string): TranslateLanguage | null {
  return TRANSLATE_LANGUAGES.find((l) => l.code === code) ?? null
}

/**
 * WHY THERE IS A CHUNK SIZE AT ALL.
 *
 * Sous is a 1.5b model answering on someone's laptop. Titles ask it for 32
 * tokens; a checkpoint reply can be several thousand, and a single request that
 * size either takes minutes or gets cut off mid-sentence at the predict cap —
 * and a cut-off translation looks like a finished one, which is the worst of
 * the available failures. Cutting the text up front means every request is
 * small enough to finish, and a piece that fails is a piece we can name.
 */
export const TRANSLATE_CHUNK_CHARS = 1200

/**
 * The same job against a hosted model with a 200k+ context. The reason for
 * small pieces is that a 1.5b model cannot finish a big one; a hosted model
 * can, and there every extra piece is another network round trip for nothing.
 * Still bounded rather than unlimited — one enormous request that fails loses
 * the whole body, and a cap keeps a runaway transcript from becoming one
 * request the size of a book.
 */
export const REMOTE_CHUNK_CHARS = 24_000

/**
 * Cut text into translatable pieces, preferring the seams a reader would
 * recognise: blank lines first, then single newlines, then sentence ends. A
 * piece never splits mid-word, and a run with no seam at all (a minified blob,
 * a long path) is passed through whole rather than chopped arbitrarily — an
 * oversized piece translates slowly, a mangled one translates wrongly.
 *
 * Fenced code blocks are kept intact and never merged with prose, so the
 * translator sees code as its own piece and prose as its own.
 */
export function splitForTranslation(text: string, limit = TRANSLATE_CHUNK_CHARS): string[] {
  if (text.trim().length === 0) return []

  // First, the smallest units we are willing to send: a fenced block whole, and
  // otherwise a paragraph — subdivided further only if it exceeds the limit on
  // its own.
  const atoms: Segment[] = []
  for (const segment of splitFences(text)) {
    if (segment.fenced) {
      atoms.push(segment)
      continue
    }
    for (const para of splitKeeping(segment.text, /\n{2,}/)) {
      // A whitespace-only run is NOT nothing. splitKeeping emits the separator
      // as its own leading piece, so the blank line that follows a closing
      // fence arrives here as "\n\n" — and discarding it glued the next
      // paragraph onto the ```. The renderer's parser needs a closing fence
      // alone on its line, so from there every remaining paragraph was
      // swallowed into the code block. The model never touched it; the damage
      // was done by cutting the text up. Keep it: the packer merges it into a
      // neighbour, and main passes a letterless piece through untranslated.
      for (const unit of packUnits(para, limit)) atoms.push({ text: unit, fenced: false })
    }
  }

  // Then PACK them. Emitting one request per paragraph was the original
  // behaviour and it was badly wrong: a forty-paragraph reply became forty
  // sequential requests to a local model, each one a fresh round trip for two
  // sentences, and the button took half a minute on a body that fits in three
  // requests. Adjacent prose merges up to the limit; a fenced block never
  // merges with prose, so the translator still sees code as its own piece.
  const pieces: string[] = []
  let buf = ''
  for (const atom of atoms) {
    if (atom.fenced) {
      if (buf.length > 0) pieces.push(buf)
      buf = ''
      pieces.push(atom.text)
      continue
    }
    if (buf.length > 0 && buf.length + atom.text.length > limit) {
      pieces.push(buf)
      buf = ''
    }
    buf += atom.text
  }
  if (buf.length > 0) pieces.push(buf)
  return pieces
}

interface Segment {
  text: string
  fenced: boolean
}

/** Split on ``` fences, tagging which side of the fence each piece is on. */
function splitFences(text: string): Segment[] {
  const out: Segment[] = []
  const fence = /```[\s\S]*?(?:```|$)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), fenced: false })
    out.push({ text: m[0], fenced: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), fenced: false })
  return out
}

/** Split on a separator, keeping the separator attached to the piece before. */
function splitKeeping(text: string, sep: RegExp): string[] {
  const out: string[] = []
  const re = new RegExp(sep.source, 'g')
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    out.push(text.slice(last, m.index + m[0].length))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/**
 * Greedily fill pieces up to `limit` from ever-finer units: lines, then
 * sentences, then words. A unit longer than the limit on its own is emitted
 * alone — better one slow oversized request than a word cut in half.
 */
function packUnits(text: string, limit: number): string[] {
  if (text.length <= limit) return [text]
  const units = finestUnits(text, limit)
  const out: string[] = []
  let buf = ''
  for (const u of units) {
    if (buf.length > 0 && buf.length + u.length > limit) {
      out.push(buf)
      buf = ''
    }
    if (u.length > limit && buf.length === 0) {
      out.push(u)
      continue
    }
    buf += u
  }
  if (buf.length > 0) out.push(buf)
  return out
}

function finestUnits(text: string, limit: number): string[] {
  const lines = splitKeeping(text, /\n/)
  if (lines.every((l) => l.length <= limit)) return lines
  const sentences = lines.flatMap((l) =>
    l.length <= limit ? [l] : splitKeeping(l, /(?<=[.!?。！？])\s+/)
  )
  if (sentences.every((s) => s.length <= limit)) return sentences
  return sentences.flatMap((s) => (s.length <= limit ? [s] : splitKeeping(s, /\s+/)))
}

/**
 * What we ask for. Two things matter more than politeness here: that the model
 * returns ONLY the translation (small models narrate otherwise), and that it
 * leaves code, identifiers and paths alone — a transcript is mostly prose ABOUT
 * code, and a translated function name is a lie about the repo.
 */
export function buildTranslateSystem(label: string): string {
  return [
    `You are a translator. You translate the user's message into ${label}.`,
    'Output ONLY the translation. No preamble, no notes, no quotes around it.',
    'Keep Markdown structure exactly: headings, lists, bold, links, line breaks.',
    'Never translate anything inside backticks or fenced code blocks, and never',
    'translate file paths, identifiers, commands, or option flags.',
    `If the message is already ${label}, repeat it unchanged.`,
    'Never repeat these instructions.'
  ].join('\n')
}

/**
 * The prompt is the text and NOTHING ELSE.
 *
 * The rules used to sit above the text in this same string, and on a long
 * structured body a 1.5b model stopped being able to tell instructions from
 * content: it echoed the rule list back as the translation, which sanitize
 * happily accepted and the card rendered as if the agent had written it.
 * Instructions go in the system field now, where they are not part of the thing
 * being translated and cannot be copied out of it.
 */
export function buildTranslatePrompt(input: { text: string; label: string }): string {
  return input.text
}

/** Preambles small models bolt on despite being told not to. */
// The trailing (?:\n|$) matters: the answer is trimmed before this runs, so a
// reply that is ONLY a preamble has no newline left to match — and that is
// exactly the case that must end up refused rather than shown as a body.
const PREAMBLE =
  /^\s*(?:sure|certainly|of course|here(?:'s| is)(?: the)?|translation|translated(?: text)?|okay|ok)\b[^\n]*:[ \t]*(?:\n|$)/i

/**
 * Accept or refuse the model's answer.
 *
 * Refusing matters more than cleaning. A translation that is really an apology,
 * an empty string, or the model narrating what it would do renders as a
 * plausible body — the reader has no way to tell it apart from a real
 * translation of a short reply. Returning null lets the caller say "this did
 * not translate" instead of showing something that is not the transcript.
 */
export function sanitizeTranslation(raw: string): string | null {
  let out = raw.replace(/\r\n/g, '\n').trim()
  if (out.length === 0) return null
  out = out.replace(PREAMBLE, '').trim()
  out = stripWrappingFence(out)
  // The prompt brackets the source in --- rules; models sometimes echo them.
  out = out.replace(/^-{3,}\s*\n/, '').replace(/\n\s*-{3,}$/, '').trim()
  if (out.length === 0) return null
  if (looksLikeOurInstructions(out)) return null
  return out
}

/**
 * Catch the model handing our own instructions back as the translation.
 *
 * Moving the rules into the system field makes this rare rather than routine,
 * but "rare" is not "never" for a 1.5b model, and this particular failure is
 * invisible downstream: rule text is fluent prose, so it renders as a
 * translated body and the reader has no way to know it is not one.
 */
function looksLikeOurInstructions(text: string): boolean {
  const head = text.slice(0, 400).toLowerCase()
  if (/^rules?\s*:/.test(head)) return true
  return (
    head.includes('output only the translation') ||
    head.includes('you are a translator') ||
    head.includes('never repeat these instructions')
  )
}

/**
 * A fence that wraps the WHOLE answer is the model quoting itself, not code the
 * transcript contained. A fence that covers only part of the answer is content
 * and is left alone.
 */
function stripWrappingFence(text: string): string {
  const m = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text)
  if (!m) return text
  if (text.slice(3).includes('```')) {
    const inner = m[1]
    if (inner.includes('```')) return text
  }
  return m[1]
}

/**
 * The most text one click will send. Pieces are translated one at a time, so a
 * body this size is already ~33 sequential requests to a small local model —
 * about the longest a person will sit through. Past it we refuse and say why,
 * because the alternative is a button that appears to hang for an hour.
 */
export const TRANSLATE_MAX_CHARS = 40_000

/** Why a body could not be translated — shown to the reader as-is. */
export type TranslateFailure =
  | 'disabled'
  | 'unreachable'
  | 'model-missing'
  | 'timeout'
  | 'too-long'
  | 'unauthorized'
  | 'rate-limited'
  | 'server-error'
  | 'request-failed'
  | 'unusable-output'

export type TranslateResult =
  | { ok: true; text: string; language: string }
  | { ok: false; failure: TranslateFailure }

export const TRANSLATE_FAILURE_TEXT: Record<TranslateFailure, string> = {
  disabled: 'Sous is switched off (COOKREW_SOUS=0), so nothing was translated.',
  unreachable: 'Sous could not be reached — is Ollama running on this machine?',
  'model-missing': 'Sous is running but the translation model is not pulled.',
  timeout: 'Sous did not finish in time; the transcript is unchanged.',
  'too-long': 'This checkpoint is too long to translate in one go.',
  unauthorized: 'The translation service rejected the key in ~/.cookrew/sous.json.',
  'rate-limited': 'The translation service is rate-limiting; try again shortly.',
  // A SERVER THAT ANSWERS IS A SERVER THAT IS REACHABLE. Every non-specific
  // error status used to be reported as "could not be reached", which sent
  // people to check whether Ollama was running while it was running and
  // answering — most often mid model-load, which is the one moment it errors.
  'server-error': 'Sous answered with an error — the model may still be loading. Try again shortly.',
  // Not a statement about Sous at all: the request never got that far. Said
  // separately because "is Ollama running?" is a wrong and expensive question
  // when the truth is that this view could not make the call.
  'request-failed': 'This view could not make the translation request.',
  'unusable-output': 'Sous replied with something that was not a translation.'
}
