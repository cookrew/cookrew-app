// What the embed needs before it can mount one agent's full view, read from
// the desktop WITHOUT touching its focused workspace: GET api/levels/agents/<id>
// (LevelsAgentDetail). The overlay renders from a TerminalNodeData; a detail
// that carries the card's own node (asked of Revel) is used as is, otherwise
// the node is drawn up from the LevelsAgent with the same preset names the
// desktop uses (src/main/presets.ts).
import type { EmbedToShell } from '../../../shared/strata'
import { apiPath } from '../api-base'
import { authStore } from '../auth-gate'
import { planeFetch } from '../plane-fetch'
import { isDetail, type EmbedDetail } from './embed-node'

export type EmbedErrorCode = Extract<EmbedToShell, { type: 'strata:error' }>['code']

export type { EmbedDetail } from './embed-node'
export { nodeOfDetail } from './embed-node'

export type DetailResult = { ok: true; detail: EmbedDetail } | { ok: false; code: EmbedErrorCode; detail?: string }

const codeOf = (status: number): EmbedErrorCode =>
  status === 404 ? 'not-found' : status === 401 || status === 403 ? 'unauthorized' : status === 502 || status === 503 ? 'offline' : 'unreachable'

export async function fetchAgentDetail(agentId: string, signal?: AbortSignal): Promise<DetailResult> {
  const token = authStore().token()
  try {
    const response = await planeFetch(apiPath(`/api/levels/agents/${encodeURIComponent(agentId)}`), {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {})
    })
    if (!response.ok) return { ok: false, code: codeOf(response.status), detail: `status ${response.status}` }
    const body: unknown = await response.json()
    if (!isDetail(body) || body.agent.id !== agentId) return { ok: false, code: 'unreachable', detail: 'not a detail' }
    return { ok: true, detail: body }
  } catch (error) {
    if (signal?.aborted) return { ok: false, code: 'unreachable', detail: 'aborted' }
    return { ok: false, code: 'unreachable', detail: error instanceof Error ? error.name : 'network' }
  }
}
