// Sous, asked to translate a checkpoint body instead of title a turn.
//
// The shape of the problem is different enough from titling to deserve its own
// path. A title is 32 tokens, fired by a background poll, and worthless if it
// costs anything — so summarizeTurn gives up instantly and stays quiet. A
// translation is thousands of tokens, asked for by a person who just clicked a
// button and is watching, so it may take its time, and when it fails it has to
// SAY so rather than degrade to silence.

import {
  SOUS_BASE_URL,
  SOUS_DISABLED,
  SOUS_KEEP_ALIVE,
  SOUS_TRANSLATE_MODEL
} from './sous-config'
import {
  buildTranslatePrompt,
  buildTranslateSystem,
  languageByCode,
  sanitizeTranslation,
  splitForTranslation,
  type TranslateFailure,
  type TranslateResult
} from '../shared/translate'

/**
 * Per-piece budget. Pieces are capped at ~1200 characters, which a 1.5b model
 * turns around in a few seconds warm; the cold call additionally waits for the
 * model to load (~10s), so the first piece gets a longer leash.
 */
const PIECE_TIMEOUT_MS = 45_000
const COLD_TIMEOUT_MS = 75_000

/** Room for the output. A piece is ~1200 chars in, so this cannot truncate. */
const NUM_PREDICT = 2048

interface OllamaGenerateResponse {
  response?: string
}

let warmed = false

/**
 * Translate one checkpoint body into `languageCode`.
 *
 * ALL OR NOTHING, deliberately. A long body is cut into pieces and translated
 * one at a time, and if any piece fails the whole call fails with the reason.
 * The alternative — return what worked — produces a body that is half one
 * language and half another with no seam marked, which reads as a bad
 * translation rather than as a failed one. Losing the finished pieces is the
 * cheaper mistake.
 *
 * Note the deliberate absence of the summarizer's `downUntil` cooldown: that
 * exists so a machine without Ollama is not polled every tick by a background
 * feature. This is a person clicking a button, so it always attempts, and it
 * tells them what happened.
 */
export async function translateBody(
  text: string,
  languageCode: string
): Promise<TranslateResult> {
  if (SOUS_DISABLED) return { ok: false, failure: 'disabled' }
  const language = languageByCode(languageCode)
  if (!language) return { ok: false, failure: 'unusable-output' }

  const pieces = splitForTranslation(text)
  if (pieces.length === 0) return { ok: true, text: '', language: language.code }

  const out: string[] = []
  for (const piece of pieces) {
    // A piece that is only whitespace or punctuation has nothing to translate
    // and would just invite the model to narrate. Carry it through verbatim.
    if (!/\p{L}/u.test(piece)) {
      out.push(piece)
      continue
    }
    const result = await translatePiece(piece, language.label)
    if (!result.ok) return result
    out.push(preserveEdgeWhitespace(piece, result.text))
  }
  return { ok: true, text: out.join(''), language: language.code }
}

type PieceResult = { ok: true; text: string } | { ok: false; failure: TranslateFailure }

async function translatePiece(piece: string, label: string): Promise<PieceResult> {
  try {
    const res = await fetch(`${SOUS_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(warmed ? PIECE_TIMEOUT_MS : COLD_TIMEOUT_MS),
      body: JSON.stringify({
        model: SOUS_TRANSLATE_MODEL,
        // Instructions in `system`, content in `prompt`. Same string for both
        // and a small model loses track of which is which — see the note on
        // buildTranslatePrompt.
        system: buildTranslateSystem(label),
        prompt: buildTranslatePrompt({ text: piece, label }),
        stream: false,
        keep_alive: SOUS_KEEP_ALIVE,
        // Low but not zero: greedy decoding on a small model loops on
        // repetitive input, and a transcript is full of repetitive input.
        options: { temperature: 0.1, num_predict: NUM_PREDICT }
      })
    })
    if (!res.ok) {
      console.error(`Sous translate: Ollama returned ${res.status} for model ${SOUS_TRANSLATE_MODEL}`)
      // 404 is Ollama's answer for a model it does not have pulled — a
      // different problem from a server that is not there, and a different fix.
      return { ok: false, failure: res.status === 404 ? 'model-missing' : 'unreachable' }
    }
    const body = (await res.json()) as OllamaGenerateResponse
    warmed = true
    const clean = sanitizeTranslation(body.response ?? '')
    if (clean === null) return { ok: false, failure: 'unusable-output' }
    return { ok: true, text: clean }
  } catch (error) {
    console.error('Sous translate: request failed:', error)
    return { ok: false, failure: isTimeout(error) ? 'timeout' : 'unreachable' }
  }
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/**
 * Put back the leading and trailing whitespace the piece carried.
 *
 * The splitter keeps separators attached, so a piece is typically "text\n\n".
 * sanitizeTranslation trims — it has to, models pad their answers — and without
 * this the paragraph breaks of the original body would all collapse and a
 * structured reply would render as one wall of text.
 */
function preserveEdgeWhitespace(original: string, translated: string): string {
  const lead = /^\s*/.exec(original)?.[0] ?? ''
  const tail = /\s*$/.exec(original)?.[0] ?? ''
  return `${lead}${translated}${tail}`
}
