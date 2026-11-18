import { UNLOCK_GRANT_PATH, type GrantDone, type GrantList, type GrantRefusal } from '../../../shared/unlock-grant'
import { cookrew } from '../api'
import { clientBase } from '../api-base'
import { authHeaders, authStore } from '../auth-gate'
import { openSeal, type SealClient } from '../path/seal-client'
import { codeKeyForBase } from '../pairing-scope'
import { sealPinFor } from '../path/seal-pin'
import { sealFetchFor } from './seal-fetch'
import { onTheMacsOwnPage } from './unlock-reach'

/**
 * A DEVICE THAT CAN ALREADY UNLOCK THE MAC, APPROVING ANOTHER (shared/unlock-grant.ts).
 * The words it shows are the Mac's, read inside the sealed session (or from a page
 * the Mac served itself): a relay can neither change them nor say yes in its place.
 */

export interface ApproveApi {
  pending(): Promise<GrantList | GrantRefusal>
  decide(id: string, allow: boolean): Promise<GrantDone | GrantRefusal>
  close(): void
}

const readAnswer = <T>(bytes: Uint8Array, status: number): T => {
  const said = JSON.parse(new TextDecoder().decode(bytes)) as { ok?: unknown; error?: unknown }
  if (typeof said.ok === 'boolean') return said as T
  throw new Error(typeof said.error === 'string' ? said.error : `The Mac could not answer (${status}).`)
}

export function sealedApproveApi(client: SealClient, auth: () => Record<string, string>): ApproveApi {
  const ask = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    const headers = { ...auth(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }
    const answer = await client.request({ method, path, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return readAnswer<T>(answer.body, answer.status)
  }
  return {
    pending: () => ask<GrantList | GrantRefusal>('GET', `${UNLOCK_GRANT_PATH}/pending`),
    decide: (id, allow) => ask<GrantDone | GrantRefusal>('POST', `${UNLOCK_GRANT_PATH}/decide`, { id, allow }),
    close: () => client.close()
  }
}

/** The way to the Mac's list, or null when this browser cannot unlock it and so cannot vouch. */
export async function openApproveApi(): Promise<ApproveApi | null> {
  if (onTheMacsOwnPage()) {
    const { unlockGrantPending: pending, unlockGrantDecide: decide } = cookrew()
    return pending && decide ? { pending, decide, close: () => undefined } : null
  }
  const code = authStore().connectCode()
  if (code === null) return null
  const base = clientBase()
  const client = await openSeal({ url: (path) => `${base}${path}`, code, fetchFn: sealFetchFor(base), pin: sealPinFor(codeKeyForBase(base)) })
  return sealedApproveApi(client, authHeaders)
}
