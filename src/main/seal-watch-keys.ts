import { existsSync, readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomic-file'
import { isDeviceKey, type DeviceKey } from '../shared/seal2/handshake'

/**
 * WHICH WATCHES THIS MAC SEALS WITH (cookrew-seal/2 device mode, a watch's side).
 *
 * A watch's account device id is a random uuid, not made from its key, so the id
 * alone pins nothing. Its key comes with its claim (watch-routes.ts), and a claim
 * is a plain request on the LAN: someone there could put a key of their own in
 * it, or swap the Mac's key in the answer. So a key starts PENDING, both screens
 * show six words over the two keys (seal2/handshake.ts · keyWords), and only when
 * the owner says on THIS Mac that the watch shows the same words does it become
 * CONFIRMED. Only a confirmed key is let in. A new claim for the same watch puts
 * its key back to pending; until the owner confirms that one, the watch is not
 * let in sealed (its old plain path still works).
 */

export interface WatchKeyRow {
  readonly deviceId: string
  readonly jwk: DeviceKey
  readonly at: number
  readonly confirmed: boolean
}

export interface SealWatchKeys {
  /** A claim brought this key for this watch. Pending until confirmed. */
  offer(deviceId: string, jwk: DeviceKey): void
  /** The owner saw the same words on the watch for exactly this key. False when it is not the key that waits. */
  confirm(deviceId: string, x: string): boolean
  /** The confirmed key for a watch, or null. */
  keyOf(deviceId: string): DeviceKey | null
  pending(): WatchKeyRow[]
  forget(deviceId: string): void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

type Held = Readonly<Record<string, { readonly x: string; readonly at: number; readonly confirmed: boolean }>>

/** Unreadable is empty: nothing confirmed, so nothing is let in sealed and the watch keeps its plain path. */
function readHeld(file: string): Held {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { watches?: unknown }
    const watches = typeof parsed.watches === 'object' && parsed.watches !== null ? (parsed.watches as Record<string, unknown>) : {}
    return Object.fromEntries(
      Object.entries(watches).flatMap(([id, row]) => {
        const r = row as { x?: unknown; at?: unknown; confirmed?: unknown }
        const fine = UUID.test(id) && isDeviceKey({ kty: 'OKP', crv: 'Ed25519', x: r.x }) && typeof r.at === 'number'
        return fine ? [[id, { x: r.x as string, at: r.at as number, confirmed: r.confirmed === true }]] : []
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
  return {
    offer(deviceId, jwk) {
      const id = idOf(deviceId)
      if (id === null || !isDeviceKey(jwk)) return
      const was = held[id]
      // The same key again stays as it was; any other key waits for the owner.
      if (was !== undefined && was.x === jwk.x) return
      write({ ...held, [id]: { x: jwk.x, at: now(), confirmed: false } })
    },
    confirm(deviceId, x) {
      const id = idOf(deviceId)
      const was = id === null ? undefined : held[id]
      if (id === null || was === undefined || was.x !== x) return false
      if (!was.confirmed) write({ ...held, [id]: { ...was, confirmed: true, at: now() } })
      return true
    },
    keyOf(deviceId) {
      const id = idOf(deviceId)
      const row = id === null ? undefined : held[id]
      return row?.confirmed === true ? keyOfX(row.x) : null
    },
    pending: () => Object.entries(held).flatMap(([deviceId, row]) => (row.confirmed ? [] : [{ deviceId, jwk: keyOfX(row.x), at: row.at, confirmed: false }])),
    forget(deviceId) {
      const id = idOf(deviceId)
      if (id === null || held[id] === undefined) return
      write(Object.fromEntries(Object.entries(held).filter(([known]) => known !== id)))
    }
  }
}
