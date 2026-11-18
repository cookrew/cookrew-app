import { createHash, timingSafeEqual } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import path from 'node:path'

/**
 * KEYS THIS COMPUTER GAVE ANOTHER OF THE OWNER'S COMPUTERS, BOUND TO THAT COMPUTER.
 *
 * Over the sealed path (serve.ts) a request reaches this computer's Magpie on
 * its loopback, and Magpie on loopback asks no key: none and a made-up one are
 * both let in with no limit (0.1.3935, measured 2026-11-18), while a real key
 * is held to its own caps. So the caps hold only if every request carries a key
 * Magpie knows. This list is how main knows one: each key it handed another
 * desktop over the seal, by Magpie's id, the last characters Magpie shows of it,
 * the SHA-256 of the key (never the key), and the account device id it was made
 * for. A key is accepted only from that device's sealed session.
 *
 * Written durably (temp, fsync, rename), 0600, outside any served sandbox
 * (owner-secrets.ts). An unreadable file accepts nothing.
 */

export const BOUND_KEYS_FILE = 'magpie-bound-keys.json'

export interface BoundKey {
  /** Magpie's id for the key. */
  readonly id: string
  /** The key's last characters, as `gateway-key list` shows them. */
  readonly tail: string
  /** SHA-256 of the key, hex. */
  readonly hash: string
  /** The account device id of the computer it was made for. */
  readonly peer: string
  readonly device: string
  readonly at: string
}

export const keyHash = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex')

const HEX64 = /^[0-9a-f]{64}$/

function parse(text: string): BoundKey[] {
  const parsed = JSON.parse(text) as { v?: unknown; keys?: unknown }
  if (parsed?.v !== 1 || !Array.isArray(parsed.keys)) throw new Error('The list of keys given to other computers is not readable.')
  return parsed.keys.map((raw) => {
    const k = raw as Record<string, unknown>
    if (typeof k?.id !== 'string' || typeof k.tail !== 'string' || typeof k.hash !== 'string' || !HEX64.test(k.hash) || typeof k.peer !== 'string' || typeof k.device !== 'string' || typeof k.at !== 'string') {
      throw new Error('A key given to another computer is not readable.')
    }
    return { id: k.id, tail: k.tail, hash: k.hash, peer: k.peer, device: k.device, at: k.at }
  })
}

export interface BoundKeys {
  /** Throws when the list cannot be read. */
  list(): readonly BoundKey[]
  add(key: BoundKey): void
  /** Forget a key by Magpie's id (it was revoked). */
  remove(id: string): void
  /** The entry for this key from this device, or null: constant-time on the hash. */
  find(peer: string, key: string): BoundKey | null
}

export interface BoundKeysStorage {
  read(): string | null
  write(text: string): void
}

export function fileStorage(file: string): BoundKeysStorage {
  return {
    read: () => {
      try {
        return readFileSync(file, 'utf8')
      } catch (error) {
        if ((error as { code?: unknown })?.code === 'ENOENT') return null
        throw error
      }
    },
    write: (text) => {
      const dir = path.dirname(file)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const tmp = `${file}.${process.pid}.tmp`
      const fd = openSync(tmp, 'w', 0o600)
      try {
        writeSync(fd, text)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, file)
    }
  }
}

export function memoryStorage(): BoundKeysStorage {
  let held: string | null = null
  return { read: () => held, write: (text) => void (held = text) }
}

export function createBoundKeys(storage: BoundKeysStorage): BoundKeys {
  const list = (): readonly BoundKey[] => {
    const text = storage.read()
    return text === null ? [] : parse(text)
  }
  const save = (keys: readonly BoundKey[]): void => storage.write(`${JSON.stringify({ v: 1, keys })}\n`)
  return {
    list,
    add: (key) => save([...list().filter((k) => k.id !== key.id), key]),
    remove: (id) => save(list().filter((k) => k.id !== id)),
    find: (peer, key) => {
      const want = Buffer.from(keyHash(key), 'hex')
      let found: BoundKey | null = null
      for (const entry of list()) {
        const same = timingSafeEqual(Buffer.from(entry.hash, 'hex'), want)
        if (same && entry.peer === peer) found = entry
      }
      return found
    }
  }
}
