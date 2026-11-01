// Sous, asked to NAME a new agent after its first prompt (owner, 2026-11-01).
//
// The stand-in name (shared/agent-name.ts · nameFromPrompt) is the prompt cut
// short — its first six Han characters for a Chinese task, cut mid-phrase. This asks
// the model for what Claude Code's /rename would title it instead.
//
// Same two roads as translation and polish: the hosted model the owner
// configured, else local Ollama on the owner's `localModel` (a 1.5b model
// names every Chinese task in English; measured, 2026-11-01). Never throws:
// null means "keep the stand-in".

import { SOUS_BASE_URL, SOUS_DISABLED, SOUS_KEEP_ALIVE, SOUS_POLISH_MODEL } from './sous-config'
import { localTranslateModel, remoteSous } from './sous-remote-config'
import { textFromContent, type MessagesResponse } from '../shared/anthropic-content'
import { buildNamePrompt, buildNameSystem, sanitizeAgentName } from '../shared/agent-name'

/**
 * How long a name may take. A cold Ollama loads the 3b model first (~16-26 s
 * measured), and a recruit is booting its harness meanwhile, so the wait is
 * mostly hidden; past it the stand-in stays.
 */
export const NAME_BUDGET_MS = 30_000

export type AgentNamer = (prompt: string) => Promise<string | null>

interface OllamaGenerateResponse {
  response?: string
}

export async function nameAgent(
  prompt: string,
  options: { budgetMs?: number; fetchFn?: typeof fetch } = {}
): Promise<string | null> {
  const task = prompt.trim()
  if (task === '' || SOUS_DISABLED) return null
  const budget = options.budgetMs ?? NAME_BUDGET_MS
  const fetchFn = options.fetchFn ?? fetch
  try {
    const answer = remoteSous() ? await nameRemote(task, budget, fetchFn) : await nameLocal(task, budget, fetchFn)
    return answer === null ? null : sanitizeAgentName(answer, task)
  } catch (error) {
    const name = (error as { name?: string } | null)?.name
    if (name !== 'TimeoutError' && name !== 'AbortError') console.error('Sous name: request failed:', error)
    return null
  }
}

async function nameLocal(task: string, budget: number, fetchFn: typeof fetch): Promise<string | null> {
  const model = localTranslateModel(SOUS_POLISH_MODEL)
  const res = await fetchFn(`${SOUS_BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(budget),
    body: JSON.stringify({
      model,
      system: buildNameSystem(),
      prompt: buildNamePrompt(task),
      stream: false,
      keep_alive: SOUS_KEEP_ALIVE,
      // qwen3 thinks for seconds before a one-line answer; qwen2.5 ignores it.
      think: false,
      options: { temperature: 0.2, num_predict: 24 }
    })
  })
  if (!res.ok) {
    console.error(`Sous name: Ollama returned ${res.status} for model ${model}`)
    return null
  }
  const body = (await res.json()) as OllamaGenerateResponse
  return body.response ?? null
}

async function nameRemote(task: string, budget: number, fetchFn: typeof fetch): Promise<string | null> {
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
      max_tokens: 64,
      system: buildNameSystem(),
      messages: [{ role: 'user', content: buildNamePrompt(task) }]
    })
  })
  if (!res.ok) {
    // Not the body: an auth failure from a proxy tends to echo the request.
    console.error(`Sous name: ${remote.model} returned ${res.status}`)
    return null
  }
  return textFromContent((await res.json()) as MessagesResponse)
}
