import { USE_SOURCES_PATH } from '../../../shared/use-sources'
import type { UnlockAnswer, UnlockBegin } from '../../../shared/remote-unlock'
import type { SealClient } from '../path/seal-client'
import type { UnlockApi } from './unlock-flow'

/**
 * THE UNLOCK ROUTES, INSIDE THE SEALED SESSION. The path is the Mac's own, with no
 * relay prefix: the terminus hands it straight to the server. The pairing token rides
 * in here too, so on this path the relay sees neither it nor the sealed password.
 */
export function sealedUnlockApi(client: SealClient, auth: () => Record<string, string>, scope: (path: string) => string = (path) => path): UnlockApi {
  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const answer = await client.request({ method: 'POST', path, headers: { ...auth(), 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const said = JSON.parse(new TextDecoder().decode(answer.body)) as { ok?: unknown; error?: unknown }
    if (typeof said.ok === 'boolean') return said as T
    throw new Error(typeof said.error === 'string' ? said.error : `The Mac could not answer (${answer.status}).`)
  }
  return {
    begin: () => post<UnlockBegin>(scope(`${USE_SOURCES_PATH}/unlock/begin`), {}),
    send: (sealed) => post<UnlockAnswer>(scope(`${USE_SOURCES_PATH}/unlock`), { sealed })
  }
}
