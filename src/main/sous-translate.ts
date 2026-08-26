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
  REMOTE_CHUNK_CHARS,
  buildTranslatePrompt,
  buildTranslateSystem,
  languageByCode,
  sanitizeTranslation,
  splitForTranslation,
  type TranslateFailure,
  type TranslateResult
} from '../shared/translate'
import { textFromContent, type MessagesResponse } from '../shared/anthropic-content'
import { localTranslateModel, remoteSous } from './sous-remote-config'

/**
 * Per-piece budget. Pieces are capped at ~1200 characters, which a 1.5b model
 * turns around in a few seconds warm; the cold call additionally waits for the
 * model to load (~10s), so the first piece gets a longer leash.
 */
const PIECE_TIMEOUT_MS = 45_000
const COLD_TIMEOUT_MS = 75_000

/** A hosted model answers a big piece in one go; give it room and time. */
const REMOTE_TIMEOUT_MS = 120_000
const REMOTE_MAX_TOKENS = 8192

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

  // A hosted model has a 200k+ context and one round trip costs a network
  // hop, so cutting a body into a dozen small pieces there is all cost and no
  // benefit — the small pieces exist because a 1.5b model cannot finish a big
  // one. Size the pieces to whoever is answering.
  const remote = remoteSous()
  const pieces = splitForTranslation(text, remote ? REMOTE_CHUNK_CHARS : undefined)
  if (pieces.length === 0) return { ok: true, text: '', language: language.code }

  const out: string[] = []
  for (const piece of pieces) {
    // A piece that is only whitespace or punctuation has nothing to translate
    // and would just invite the model to narrate. Carry it through verbatim.
    if (!/\p{L}/u.test(piece)) {
      out.push(piece)
      continue
    }
    // NEVER SEND A CODE BLOCK.
    //
    // The system prompt tells the model not to translate fenced code, and the
    // model obeys — it copies it out, character for character, which on a real
    // block measured 18.5 SECONDS to return a byte-identical answer. A
    // checkpoint with a few command transcripts in it spends minutes that way
    // and hits the per-piece timeout, which is what a long translation dying
    // halfway actually was. The splitter already keeps a fence whole and
    // separate, so the right answer is not to ask.
    if (isFencedCode(piece)) {
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
  const remote = remoteSous()
  return remote ? translateRemote(piece, label) : translateLocal(piece, label)
}

/**
 * A hosted, Anthropic-compatible model. Same contract as the local path: a
 * named failure rather than an exception, and never a partial answer passed off
 * as a whole one.
 */
async function translateRemote(piece: string, label: string): Promise<PieceResult> {
  const remote = remoteSous()
  if (!remote) return { ok: false, failure: 'unreachable' }
  try {
    const res = await fetch(`${remote.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': remote.apiKey,
        'anthropic-version': '2023-06-01'
      },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      body: JSON.stringify({
        model: remote.model,
        max_tokens: REMOTE_MAX_TOKENS,
        system: buildTranslateSystem(label),
        messages: [{ role: 'user', content: buildTranslatePrompt({ text: piece, label }) }]
      })
    })
    if (!res.ok) {
      // Deliberately not logging the body: an auth failure from a proxy tends
      // to echo the request, and the request carries the key.
      console.error(`Sous translate: ${remote.model} returned ${res.status}`)
      if (res.status === 401 || res.status === 403) return { ok: false, failure: 'unauthorized' }
      if (res.status === 404) return { ok: false, failure: 'model-missing' }
      if (res.status === 429) return { ok: false, failure: 'rate-limited' }
      return { ok: false, failure: 'server-error' }
    }
    const clean = sanitizeTranslation(textFromContent((await res.json()) as MessagesResponse))
    if (clean === null) return { ok: false, failure: 'unusable-output' }
    return { ok: true, text: clean }
  } catch (error) {
    console.error('Sous translate: remote request failed:', error)
    return { ok: false, failure: isTimeout(error) ? 'timeout' : 'unreachable' }
  }
}

async function translateLocal(piece: string, label: string): Promise<PieceResult> {
  try {
    const res = await fetch(`${SOUS_BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(warmed ? PIECE_TIMEOUT_MS : COLD_TIMEOUT_MS),
      body: JSON.stringify({
        model: localTranslateModel(SOUS_TRANSLATE_MODEL),
        // Instructions in `system`, content in `prompt`. Same string for both
        // and a small model loses track of which is which — see the note on
        // buildTranslatePrompt.
        system: buildTranslateSystem(label),
        prompt: buildTranslatePrompt({ text: piece, label }),
        stream: false,
        keep_alive: SOUS_KEEP_ALIVE,
        // Low but not zero: greedy decoding on a small model loops on
        // repetitive input, and a transcript is full of repetitive input.
        // repeat_penalty for the same reason — it is the setting that actually
        // ends a loop rather than waiting for the token cap to end it.
        options: {
          temperature: 0.1,
          repeat_penalty: 1.1,
          num_predict: predictFor(piece)
        }
      })
    })
    if (!res.ok) {
      console.error(`Sous translate: Ollama returned ${res.status} for model ${localTranslateModel(SOUS_TRANSLATE_MODEL)}`)
      // 404 is Ollama's answer for a model it does not have pulled — a
      // different problem from a server that is not there, and a different fix.
      // Answered, so it is reachable — a 5xx here is most often the model
      // still loading, which is a different sentence and a different wait.
      return { ok: false, failure: res.status === 404 ? 'model-missing' : 'server-error' }
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

/** A piece the splitter cut at a ``` fence: code, not prose. */
function isFencedCode(piece: string): boolean {
  return piece.trimStart().startsWith('```')
}

/**
 * Room for the answer, scaled to the question.
 *
 * A flat 2048 is a licence to loop: given repetitive input — and a transcript
 * is full of it — a small model will happily generate to the cap, which is 20+
 * seconds spent on an answer that is already wrong. A translation is not many
 * times longer than its source, and CJK is denser than English, so half the
 * source length in tokens is generous. The floor keeps short pieces workable.
 */
function predictFor(piece: string): number {
  return Math.min(2048, Math.max(256, Math.ceil(piece.length / 2)))
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
