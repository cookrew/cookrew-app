// Sous — local-model turn summarizer (main process side). Talks to a local
// Ollama server; when it is not running the feature degrades silently and
// cards keep their prompt-snippet titles.
//
// Config (env):
//   COOKREW_SOUS=0            disable entirely
//   COOKREW_SOUS_URL          Ollama base URL (default http://127.0.0.1:11434)
//   COOKREW_SOUS_MODEL        model name       (default qwen2.5:1.5b)

import { buildTitlePrompt, sanitizeTitle, TitleInput } from '../shared/sous'

const BASE_URL = process.env.COOKREW_SOUS_URL ?? 'http://127.0.0.1:11434'
const MODEL = process.env.COOKREW_SOUS_MODEL ?? 'qwen2.5:1.5b'
const DISABLED = process.env.COOKREW_SOUS === '0'

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
const KEEP_ALIVE = process.env.COOKREW_SOUS_KEEPALIVE ?? '5m'
/** After a failed request, stop trying for this long (server likely down). */
const DOWN_COOLDOWN_MS = 60_000

let downUntil = 0
let warmed = false

export type TurnSummarizer = (input: TitleInput) => Promise<string | null>

interface OllamaGenerateResponse {
  response?: string
}

/**
 * Ask the local model to title the turn. Returns null on any failure —
 * missing server, missing model, timeout, unusable output — and backs off
 * for a cooldown after network errors so a machine without Ollama never
 * sees a request per poll.
 */
export async function summarizeTurn(input: TitleInput): Promise<string | null> {
  if (DISABLED || Date.now() < downUntil) return null
  try {
    const res = await fetch(`${BASE_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(warmed ? REQUEST_TIMEOUT_MS : COLD_TIMEOUT_MS),
      body: JSON.stringify({
        model: MODEL,
        prompt: buildTitlePrompt(input),
        stream: false,
        keep_alive: KEEP_ALIVE,
        options: { temperature: 0.2, num_predict: 32 }
      })
    })
    if (!res.ok) {
      // 404 = model not pulled; other statuses = server-side trouble. Either
      // way, back off instead of retrying every refresh tick.
      console.error(`Sous: Ollama returned ${res.status} for model ${MODEL}`)
      downUntil = Date.now() + DOWN_COOLDOWN_MS
      return null
    }
    const body = (await res.json()) as OllamaGenerateResponse
    warmed = true
    return sanitizeTitle(body.response ?? '')
  } catch (error) {
    console.error('Sous: summarize request failed:', error)
    downUntil = Date.now() + DOWN_COOLDOWN_MS
    return null
  }
}
