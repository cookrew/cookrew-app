import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-file'
import { isDeviceKey, KEY_WORDS_NONCE_BYTES, type DeviceKey } from '../shared/seal2/handshake'

/**
 * WHICH WATCHES THIS MAC SEALS WITH (cookrew-seal/2 device mode, a watch's side).
 *
 * A watch's account device id is a random uuid, not made from its key, so the id
 * alone pins nothing. Its key comes with its claim (watch-routes.ts), and a claim
 * is a plain request on the LAN or through the relay: someone there could put a
 * key of their own in it, or swap the Mac's key in the answer. So a key starts
 * PENDING, with a fresh nonce of this Mac's; both screens show six words over the
 * two keys and that nonce (seal2/handshake.ts · keyWords), each screen computing
 * them itself; and only when the owner says on THIS Mac that the watch shows the
 * same words does it become CONFIRMED. Only a confirmed key is let in.
 *
 * A new claim with another key waits BESIDE the confirmed one: the watch already
 * let in keeps working until the owner confirms the new key, and "not the same"
 * drops only the key that waited. So a claim, which anyone with a live code can
 * make on the LAN under any id, cannot shut a confirmed watch out.
 */

export interface PendingWatchKeyRow {
  readonly deviceId: string
  readonly jwk: DeviceKey
  readonly nonce: Uint8Array
  readonly at: number
}

export interface SealWatchKeys {
  /** A claim brought this key for this watch: it waits, with a fresh nonce; that nonce is returned. Null for no key. */
  offer(deviceId: string, jwk: DeviceKey): Uint8Array | null
  /** The owner saw the same words on the watch for exactly this waiting key. False when it is not the key that waits. */
  confirm(deviceId: string, x: string): boolean
  /** The confirmed key for a watch, or null. */
  keyOf(deviceId: string): DeviceKey | null
  pending(): PendingWatchKeyRow[]
  /** "Not the same": only the key that waited goes. */
  dropPending(deviceId: string): void
  /** The watch was forgotten on this Mac: everything held for watches goes. */
  forgetAll(): void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A key that waited this long without the owner's word is let go. */
const PENDING_MS = 24 * 60 * 60 * 1000

interface Row {
  readonly confirmed?: string
  readonly pending?: { readonly x: string; readonly nonce: string; readonly at: number }
}
type Held = Readonly<Record<string, Row>>

const isX = (x: unknown): x is string => isDeviceKey({ kty: 'OKP', crv: 'Ed25519', x })

/** Unreadable is empty: nothing confirmed, so nothing is let in sealed and the watch keeps its plain path. */
function readHeld(file: string): Held {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { watches?: unknown }
    const watches = typeof parsed.watches === 'object' && parsed.watches !== null ? (parsed.watches as Record<string, Row>) : {}
    return Object.fromEntries(
      Object.entries(watches).flatMap(([id, row]): Array<[string, Row]> => {
        if (!UUID.test(id) || typeof row !== 'object' || row === null) return []
        const confirmed = isX(row.confirmed) ? row.confirmed : undefined
        const p = row.pending
        const pending = p && isX(p.x) && typeof p.nonce === 'string' && Buffer.from(p.nonce, 'base64url').length === KEY_WORDS_NONCE_BYTES && typeof p.at === 'number' ? p : undefined
        return confirmed === undefined && pending === undefined ? [] : [[id, { ...(confirmed ? { confirmed } : {}), ...(pending ? { pending } : {}) }]]
      })
    )
  } catch {
    return {}
  }
}

const keyOfX = (x: string): DeviceKey => ({ kty: 'OKP', crv: 'Ed25519', x })

export function createSealWatchKeys(file: string, now: () => number = Date.now): SealWatchKeys {
  let held = readHeld(file)
  const write = (next: Held): void => {
    held = next
    writeFileAtomic(file, `${JSON.stringify({ watches: next }, null, 2)}\n`)
  }
  const idOf = (deviceId: string): string | null => {
    const id = deviceId.toLowerCase()
    return UUID.test(id) ? id : null
  }
  const withRow = (id: string, row: Row): Held => {
    const rest = Object.fromEntries(Object.entries(held).filter(([known]) => known !== id))
    return row.confirmed === undefined && row.pending === undefined ? rest : { ...rest, [id]: row }
  }
  const live = (row: Row | undefined): Row['pending'] => (row?.pending && now() - row.pending.at < PENDING_MS ? row.pending : undefined)
  return {
    offer(deviceId, jwk) {
      const id = idOf(deviceId)
      if (id === null || !isDeviceKey(jwk)) return null
      const row = held[id] ?? {}
      // Even the key already let in gets words again: a watch that lost what it kept learns this Mac's key
      // only through words it compared itself, never from an answer saying "already let in".
      const nonce = randomBytes(KEY_WORDS_NONCE_BYTES)
      write(withRow(id, { ...row, pending: { x: jwk.x, nonce: nonce.toString('base64url'), at: now() } }))
      return new Uint8Array(nonce)
    },
    confirm(deviceId, x) {
      const id = idOf(deviceId)
      const row = id === null ? undefined : held[id]
      const waiting = live(row)
      if (id === null || row === undefined || waiting === undefined || waiting.x !== x) return false
      write(withRow(id, { confirmed: x }))
      return true
    },
    keyOf(deviceId) {
      const id = idOf(deviceId)
      const confirmed = id === null ? undefined : held[id]?.confirmed
      return confirmed === undefined ? null : keyOfX(confirmed)
    },
    pending: () =>
      Object.entries(held).flatMap(([deviceId, row]) => {
        const waiting = live(row)
        return waiting ? [{ deviceId, jwk: keyOfX(waiting.x), nonce: new Uint8Array(Buffer.from(waiting.nonce, 'base64url')), at: waiting.at }] : []
      }),
    dropPending(deviceId) {
      const id = idOf(deviceId)
      const row = id === null ? undefined : held[id]
      if (id === null || row?.pending === undefined) return
      write(withRow(id, row.confirmed === undefined ? {} : { confirmed: row.confirmed }))
    },
    forgetAll() {
      if (Object.keys(held).length > 0) write({})
    }
  }
}
