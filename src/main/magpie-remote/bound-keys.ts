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
 * Written durably (temp, fsync, rename, folder sync), 0600, outside any served
 * sandbox (owner-secrets.ts). An unreadable file accepts nothing.
 *
 * A key just given is `pending` until its computer acknowledges it (serve.ts ·
 * MAGPIE_KEY_ACK_PATH): it is found, so the acknowledgement can be checked, but
 * no model request is served with it. While any key is pending the file is
 * written as v2, which an older Cookrew (v1 only) refuses as unreadable: it
 * accepts nothing rather than honour a key nobody confirmed. Once none is, v1.
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
  /** Given, but not yet acknowledged by its computer: honoured for nothing but that acknowledgement. Absent = live. */
  readonly pending?: boolean
}

export const keyHash = (key: string): string => createHash('sha256').update(key, 'utf8').digest('hex')

const HEX64 = /^[0-9a-f]{64}$/

/** When a key was made for a computer: how often one computer may be given a new key. */
export interface IssuedAt {
  readonly peer: string
  readonly at: number
}

interface Stored {
  readonly keys: BoundKey[]
  readonly issued: IssuedAt[]
}

function parse(text: string): Stored {
  const parsed = JSON.parse(text) as { v?: unknown; keys?: unknown; issued?: unknown }
  if ((parsed?.v !== 1 && parsed?.v !== 2) || !Array.isArray(parsed.keys)) throw new Error('The list of keys given to other computers is not readable.')
  if (parsed.issued !== undefined && !Array.isArray(parsed.issued)) throw new Error('The list of keys given to other computers is not readable.')
  const issued = ((parsed.issued as unknown[] | undefined) ?? []).map((raw) => {
    const r = raw as Record<string, unknown>
    if (typeof r?.peer !== 'string' || typeof r.at !== 'number') throw new Error('A key given to another computer is not readable.')
    return { peer: r.peer, at: r.at }
  })
  const keys = parsed.keys.map((raw) => {
    const k = raw as Record<string, unknown>
    if (typeof k?.id !== 'string' || typeof k.tail !== 'string' || typeof k.hash !== 'string' || !HEX64.test(k.hash) || typeof k.peer !== 'string' || typeof k.device !== 'string' || typeof k.at !== 'string') {
      throw new Error('A key given to another computer is not readable.')
    }
    if (k.pending !== undefined && typeof k.pending !== 'boolean') throw new Error('A key given to another computer is not readable.')
    return { id: k.id, tail: k.tail, hash: k.hash, peer: k.peer, device: k.device, at: k.at, ...(k.pending === true ? { pending: true } : {}) }
  })
  return { keys, issued }
}

/** How far back the issue log is kept, and so the window the per-computer limit counts over. */
export const ISSUE_WINDOW_MS = 24 * 60 * 60 * 1000

export interface BoundKeys {
  /** Throws when the list cannot be read. */
  list(): readonly BoundKey[]
  add(key: BoundKey): void
  /** Its computer acknowledged the key: it is live. A no-op for a key not held, or one already live. */
  confirm(id: string): void
  /** Forget a key by Magpie's id (it was revoked). */
  remove(id: string): void
  /** The entry for this key from this device, or null: constant-time on the hash. */
  find(peer: string, key: string): BoundKey | null
  /** Keys made for this computer since `since` (epoch ms). */
  issuedSince(peer: string, since: number): number
  /** A key was made for this computer at `at`; entries older than the window are dropped. */
  noteIssued(peer: string, at: number): void
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
      // A fixed name, so the served sandbox's deny list can name it (owner-secrets.ts).
      const tmp = `${file}.tmp`
      const fd = openSync(tmp, 'w', 0o600)
      try {
        writeSync(fd, text)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, file)
      // The rename itself must survive a crash: a key acknowledged must stay bound.
      if (process.platform === 'win32') return
      const dirFd = openSync(dir, 'r')
      try {
        fsyncSync(dirFd)
      } finally {
        closeSync(dirFd)
      }
    }
  }
}


export function memoryStorage(): BoundKeysStorage {
  let held: string | null = null
  return { read: () => held, write: (text) => void (held = text) }
}

export function createBoundKeys(storage: BoundKeysStorage): BoundKeys {
  const read = (): Stored => {
    const text = storage.read()
    return text === null ? { keys: [], issued: [] } : parse(text)
  }
  const list = (): readonly BoundKey[] => read().keys
  const save = (next: Stored): void => storage.write(`${JSON.stringify({ v: next.keys.some((k) => k.pending === true) ? 2 : 1, ...next })}\n`)
  return {
    list,
    add: (key) => {
      const now = read()
      save({ ...now, keys: [...now.keys.filter((k) => k.id !== key.id), key] })
    },
    confirm: (id) => {
      const now = read()
      if (!now.keys.some((k) => k.id === id && k.pending === true)) return
      save({ ...now, keys: now.keys.map((k) => (k.id === id ? { id: k.id, tail: k.tail, hash: k.hash, peer: k.peer, device: k.device, at: k.at } : k)) })
    },
    remove: (id) => {
      const now = read()
      save({ ...now, keys: now.keys.filter((k) => k.id !== id) })
    },
    issuedSince: (peer, since) => read().issued.filter((i) => i.peer === peer && i.at >= since).length,
    noteIssued: (peer, at) => {
      const now = read()
      save({ ...now, issued: [...now.issued.filter((i) => i.at >= at - ISSUE_WINDOW_MS), { peer, at }] })
    },
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
