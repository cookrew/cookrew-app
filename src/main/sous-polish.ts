// Sous, asked to clean up dictation instead of title a turn.
//
// Same two roads as translation — the local Ollama model, or the hosted one
// the owner configured — with one difference in temperament: a person has
// just let go of the key and is watching their words land, so this call has
// a BUDGET, and when the budget is gone the raw transcript is used. Losing a
// second is fine; losing the words is not.

import { SOUS_BASE_URL, SOUS_DISABLED, SOUS_KEEP_ALIVE, SOUS_POLISH_MODEL } from './sous-config'
import { remoteSous } from './sous-remote-config'
import { textFromContent, type MessagesResponse } from '../shared/anthropic-content'
import { buildPolishPrompt, buildPolishSystem, needsPolish, sanitizePolish } from '../shared/sous-polish'

/** The wait a person tolerates between letting go of the key and seeing text. */
export const POLISH_BUDGET_MS = 2500

export type PolishResult = { ok: true; text: string; polished: boolean } | { ok: false; reason: string }

interface OllamaGenerateResponse {
  response?: string
}

/**
 * The cleaned transcript, or the transcript itself when cleaning was not
 * possible in time — `polished` says which, so a surface can show the
 * difference. Never throws; never returns nothing.
 */
export async function polishTranscript(
  transcript: string,
  options: { budgetMs?: number; fetchFn?: typeof fetch } = {}
): Promise<{ text: string; polished: boolean }> {
  const raw = transcript.trim()
  if (!needsPolish(raw) || SOUS_DISABLED) return { text: raw, polished: false }
  const budget = options.budgetMs ?? POLISH_BUDGET_MS
  const fetchFn = options.fetchFn ?? fetch
  try {
    const remote = remoteSous()
    const answer = remote ? await polishRemote(raw, budget, fetchFn) : await polishLocal(raw, budget, fetchFn)
    const clean = answer === null ? null : sanitizePolish(answer, raw)
    if (clean === null) return { text: raw, polished: false }
    return { text: clean, polished: true }
  } catch (error) {
    // A timeout is the expected way to lose; say so once, quietly.
    const name = (error as { name?: string } | null)?.name
    if (name !== 'TimeoutError' && name !== 'AbortError') console.error('Sous polish: request failed:', error)
    return { text: raw, polished: false }
  }
}

async function polishLocal(raw: string, budget: number, fetchFn: typeof fetch): Promise<string | null> {
  const res = await fetchFn(`${SOUS_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(budget),
    body: JSON.stringify({
      model: SOUS_POLISH_MODEL,
      system: buildPolishSystem(),
      prompt: buildPolishPrompt(raw),
      stream: false,
      keep_alive: SOUS_KEEP_ALIVE,
      // qwen3 thinks for seconds before a one-line answer and returns nothing
      // within a voice budget without this; qwen2.5 ignores the field.
      think: false,
      // Room for the answer scaled to the question — a cleaned sentence is not
      // longer than what was said, and a cap is what ends a looping small model.
      options: { temperature: 0.1, repeat_penalty: 1.1, num_predict: Math.min(512, Math.max(64, raw.length)) }
    })
  })
  if (!res.ok) {
    console.error(`Sous polish: Ollama returned ${res.status} for model ${SOUS_POLISH_MODEL}`)
    return null
  }
  const body = (await res.json()) as OllamaGenerateResponse
  return body.response ?? null
}

async function polishRemote(raw: string, budget: number, fetchFn: typeof fetch): Promise<string | null> {
  const remote = remoteSous()
  if (!remote) return null
  const res = await fetchFn(`${remote.baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': remote.apiKey,
      'anthropic-version': '2023-06-01'
    },
    signal: AbortSignal.timeout(budget),
    body: JSON.stringify({
      model: remote.model,
      max_tokens: 1024,
      system: buildPolishSystem(),
      messages: [{ role: 'user', content: buildPolishPrompt(raw) }]
    })
  })
  if (!res.ok) {
    // Not the body: an auth failure from a proxy tends to echo the request.
    console.error(`Sous polish: ${remote.model} returned ${res.status}`)
    return null
  }
  return textFromContent((await res.json()) as MessagesResponse)
}
