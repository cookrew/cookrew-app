import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ProxiedDoor } from './relay-proxy'

/**
 * WHICH REGISTRY EACH IMPORTED DOOR CAME FROM.
 *
 * A card placed today must still work next month, after the app has restarted
 * and forgotten everything. The card carries the door's NAME — that is what is
 * durable about it — but a name alone does not say which directory to ask, and
 * guessing would mean a team imported from a private registry silently being
 * looked up on the public one.
 *
 * ONLY THE ORIGIN IS KEPT. The seal key is deliberately NOT stored here: it is
 * fetched fresh from the directory each time, so an owner who rotates their
 * door's key does not leave every caller stuck on a key that no longer opens
 * anything. The pin is per-connection, not per-lifetime.
 */

interface Entry {
  relayOrigin: string
}

function bookFile(): string {
  return path.join(homedir(), '.cookrew', 'relay-doors.json')
}

function read(): Record<string, Entry> {
  const file = bookFile()
  if (!existsSync(file)) return {}
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Entry>) : {}
  } catch {
    return {}
  }
}

/** Remember where a door was imported from. Overwrites; the newest wins. */
export function rememberDoor(name: string, relayOrigin: string): void {
  const file = bookFile()
  const book = { ...read(), [name]: { relayOrigin } }
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(book, null, 2), { mode: 0o600 })
  chmodSync(file, 0o600)
}

/** Has this app ever imported a relayed team? */
export function importedDoors(): boolean {
  return Object.keys(read()).length > 0
}

export function doorOrigin(name: string): string | null {
  return read()[name]?.relayOrigin ?? null
}

/**
 * Resolve a door for the proxy: which registry, then that registry's record.
 *
 * Returns null for a name this app was never told about — a card that names a
 * door nobody here imported is answered as not found rather than looked up on
 * a registry chosen by default.
 */
export async function resolveDoor(name: string): Promise<ProxiedDoor | null> {
  const origin = doorOrigin(name)
  if (!origin) return null
  try {
    const found = await fetch(new URL(`/v1/doors/${name}`, origin), {
      redirect: 'manual',
      signal: AbortSignal.timeout(5000)
    })
    if (!found.ok) return null
    const record = (await found.json()) as { sealKey?: unknown; transport?: unknown }
    if (typeof record.sealKey !== 'string' || record.transport !== 'relay') return null
    return { name, key: record.sealKey, relayOrigin: origin }
  } catch {
    return null
  }
}
