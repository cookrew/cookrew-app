// Sous — local-model turn summarizer (main process side). Talks to a local
// Ollama server; when it is not running the feature degrades silently and
// cards keep their prompt-snippet titles.
//
// Config (env):
//   COOKREW_SOUS=0            disable entirely
//   COOKREW_SOUS_URL          Ollama base URL (default http://127.0.0.1:11434)
//   COOKREW_SOUS_MODEL        model name       (default qwen2.5:1.5b)

import { buildTitlePrompt, sanitizeTitle, TitleInput } from '../shared/sous'
import {
  createSousBreaker,
  type SousAttempt,
  type SousBreakerState,
  type SousReadiness
} from './sous-breaker'
import { SOUS_BASE_URL, SOUS_DISABLED, SOUS_KEEP_ALIVE, SOUS_MODEL } from './sous-config'

const BASE_URL = SOUS_BASE_URL
const MODEL = SOUS_MODEL
const DISABLED = SOUS_DISABLED

/** Per-request budget — a stuck local server must not pile up requests. */
const REQUEST_TIMEOUT_MS = 8000
/**
 * First-request budget: Ollama loads the model into memory on the first
 * generate (~10s for a 1.5b model), so the cold call gets a longer leash.
 */
const COLD_TIMEOUT_MS = 30_000
/**
 * How long Ollama keeps the model resident after a title request. Default 5m
 * so a ~1.25GB model doesn't sit resident all day for occasional titles — it
 * unloads after 5 idle minutes and pays the ~10s cold start on the next
 * title (covered by COLD_TIMEOUT_MS). Override with COOKREW_SOUS_KEEPALIVE.
 */
const KEEP_ALIVE = SOUS_KEEP_ALIVE

/**
 * Every request goes through the breaker (sous-breaker.ts): a server that
 * is down or too slow to answer inside the budget costs a bounded number of
 * probes on a widening schedule, not a request per tick, and explains itself
 * once when the breaker opens rather than once per attempt.
 */
const breaker = createSousBreaker()
let warmed = false

export type TurnSummarizer = (input: TitleInput) => Promise<string | null>

interface OllamaGenerateResponse {
  response?: string
}

/**
 * Would a title request be attempted right now? Callers skip their work
 * when not: 'open' means the breaker is holding requests back for a window,
 * 'busy' that both in-flight slots are taken and a moment later may do.
 */
export function sousReadiness(): SousReadiness {
  return DISABLED ? 'open' : breaker.readiness()
}

/** The breaker, read-only, for GET /api/health. */
export function sousBreakerState(): SousBreakerState {
  return breaker.state()
}

async function requestTitle(prompt: string): Promise<SousAttempt<string | null>> {
  const res = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(warmed ? REQUEST_TIMEOUT_MS : COLD_TIMEOUT_MS),
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: false,
      keep_alive: KEEP_ALIVE,
      options: { temperature: 0.2, num_predict: 32 }
    })
  })
  // 404 = model not pulled; other statuses = server-side trouble. Either way
  // it is a failure the breaker counts.
  if (!res.ok) return { ok: false, reason: `Ollama returned ${res.status} for model ${MODEL}` }
  const body = (await res.json()) as OllamaGenerateResponse
  warmed = true
  return { ok: true, value: sanitizeTitle(body.response ?? '') }
}

/**
 * Ask the local model to title the turn. Returns null on any failure —
 * missing server, missing model, timeout, unusable output — and null at once,
 * without a request, while the breaker is open.
 */
export async function summarizeTurn(input: TitleInput): Promise<string | null> {
  if (DISABLED) return null
  // Built before the guard: a bug in the prompt is ours, not a Sous failure,
  // and must not be counted by the breaker or blamed on the server.
  const prompt = buildTitlePrompt(input)
  return breaker.guard(() => requestTitle(prompt))
}
