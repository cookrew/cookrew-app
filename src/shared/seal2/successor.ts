import { connectCodeId, replacedKeyOf } from '../canvas-seal'
import { fromB64u, toB64u, utf8 } from './bytes'

/**
 * "THIS IS MY NEW CODE", SAID WITH THE OLD ONE.
 *
 * A v2 Mac that refuses a code it replaced also names its current code: an HMAC,
 * under the key only the holder of the old code can check (canvas-seal.ts ·
 * replacedKeyOf), over the old code's id and the new code's id. A page that holds
 * the old code takes a code waiting beside it (a link someone handed it, a scan)
 * only when this vouches for exactly that code. A carrier cannot make it, and a
 * link anybody can make cannot get a code of its own adopted by a pinned page.
 */

const LABEL = 'cookrew-seal/2 successor'

const hmacKey = (key: Uint8Array, usage: KeyUsage): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, [usage])

const message = (oldId: string, newId: string): Uint8Array => utf8(`${LABEL}\n${oldId}\n${newId}`)

/** The Mac's side: `replacedKey` is the old code's (connect-code.ts keeps it), `newId` its current code's id. */
export async function proveSuccessor(replacedKey: Uint8Array, oldId: string, newId: string): Promise<string> {
  return toB64u(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(replacedKey, 'sign'), message(oldId, newId) as BufferSource)))
}

/** The page's side: true only when `proof` says `next` is the code that replaced `old`. */
export async function checkSuccessor(old: Uint8Array, next: Uint8Array, proof: unknown): Promise<boolean> {
  const raw = fromB64u(proof)
  if (raw === null || raw.length !== 32) return false
  const [oldId, newId] = [await connectCodeId(old), await connectCodeId(next)]
  return crypto.subtle.verify('HMAC', await hmacKey(await replacedKeyOf(old), 'verify'), raw, message(oldId, newId) as BufferSource)
}
