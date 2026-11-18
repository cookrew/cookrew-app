import { nextCodeKey } from '../pairing-scope'
import { checkSuccessor } from '../../../shared/seal2/successor'
import { SealRefusedError } from './seal-client'

/**
 * THE CODE WAITING BESIDE A REPLACED ONE, ONLY IF THE MAC VOUCHED FOR IT.
 *
 * A code handed in a link waits beside the one held (pairing-scope.ts), and a link
 * is something anybody can make. For a machine pinned to v2 the waiting code is
 * taken only when the Mac's refusal of the old code names it as the successor,
 * with a proof only the holder of the old code can check (seal2/successor.ts).
 * Anything else, a bare "no such code" a carrier can forge included, takes no
 * code: the page shows re-pair.
 */

const CODE_SHAPE = /^[A-Za-z0-9_-]{43}$/

const bytesOf = (encoded: string): Uint8Array => Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

export async function vouchedNextCode(storage: Pick<Storage, 'getItem' | 'removeItem'>, codeKey: string, held: string, failure: unknown): Promise<string | null> {
  if (!(failure instanceof SealRefusedError) || failure.why !== 'replaced' || failure.successor === undefined) return null
  let waiting: string | null = null
  try {
    waiting = storage.getItem(nextCodeKey(codeKey))
  } catch {
    return null
  }
  if (waiting === null || !CODE_SHAPE.test(waiting) || !CODE_SHAPE.test(held)) return null
  if (!(await checkSuccessor(bytesOf(held), bytesOf(waiting), failure.successor).catch(() => false))) return null
  try {
    storage.removeItem(nextCodeKey(codeKey))
  } catch {
    // Taken anyway: it was vouched for.
  }
  return waiting
}
