/**
 * WHERE A SEALED SECRET LIVES: ~/.cookrew/secrets/<name>, one file each.
 *
 * ENCRYPTED AT REST (owner 2026-11-05). The file holds ciphertext; the key
 * sits in the keychain under the app's own ACL (a SecretSealer, in the app
 * Electron's safeStorage: secrets-seal.ts). So a process reading the file gets
 * nothing, and `security` stops at a password prompt: an agent has to go
 * through `cookrew secret`, which is the audited way. File modes alone could
 * not say that, because every agent runs as the owner.
 *
 * The same discipline as ~/.cookrew/stripe.env as well: a directory nobody
 * else can list (0700), a file nobody else can read (0600), written whole to a
 * sibling and renamed into place so a crash leaves the old value or the new
 * one and never half of either. The value is returned by `read` and by
 * nothing else — `list` carries names and dates, the audit line carries the
 * name, a thrown error carries the name, and no event, no workspace state
 * and no log ever sees the value.
 *
 * `served` is a flag with no reader yet: a secret the owner marked "served
 * sessions may read" is still unreadable from a served pane in this round
 * (secret-cli.ts refuses before it looks). The flag is kept so the owner's
 * choice survives until the route that honours it exists.
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { isSecretName, type SecretListing } from '../shared/secret-slot'

export type { SecretListing } from '../shared/secret-slot'

export interface SecretRecord {
  readonly value: string
  readonly served: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

/**
 * THE OLD KEYCHAIN OPT-IN, READ ONLY. An environment switch used to put a
 * value in the login keychain through the `security` tool, which showed it on
 * a command line and left an item any process of the owner's could read back
 * with that same tool. Nothing writes that way now: a file marked `keychain` is
 * read once more, sealed by `migrate`, and its item goes.
 */
export const KEYCHAIN_ACCOUNT = 'cookrew'
export const keychainService = (name: string): string => `cookrew-secret-${name}`

/**
 * What is sealed: the name, then the value. safeStorage is AES-CBC with no
 * authentication, so a wrong key can open to noise that merely looks valid;
 * the name says it opened, and that this file is the one it was sealed into.
 */
const sealedText = (name: string, value: string): string => `cookrew-secret:${name}\n${value}`

const valueIn = (name: string, text: string): string => {
  const head = `cookrew-secret:${name}\n`
  if (!text.startsWith(head)) throw new Error('not this secret')
  return text.slice(head.length)
}

/** What encrypts a value. Sync, as the store is; a throw is a refusal. */
export interface SecretSealer {
  readonly available: () => boolean
  readonly seal: (value: string) => Buffer
  readonly open: (box: Buffer) => string
}


export interface SecretsStore {
  readonly put: (name: string, value: string, options?: { served?: boolean }) => SecretListing
  readonly read: (name: string) => SecretRecord | null
  readonly list: () => SecretListing[]
  readonly remove: (name: string) => boolean
  /**
   * Seal every value still in the clear (or in the old keychain item), and
   * tell the backups to leave the directory out. Each file is replaced only
   * after its sealed copy has opened back to the same value; a file that
   * fails stays exactly as it was and is named in `failed`.
   */
  readonly migrate: () => { sealed: string[]; failed: string[] }
  /** Fires after a put or a remove: the scrub drops its value table on it. */
  readonly onChange: (listener: () => void) => () => void
  readonly dir: string
}

export interface SecretsStoreOptions {
  readonly baseDir?: string
  readonly now?: () => number
  /** Encrypts what is written. Absent, a value is written as it comes: tests, and platforms with no keychain. */
  readonly sealer?: SecretSealer
  /** Refuse a write the sealer cannot take, rather than leave it in the clear. */
  readonly requireSealer?: boolean
  /** Keep the directory out of backups; told once it exists. */
  readonly excludeFromBackup?: (dir: string) => void
  /** A line for the log: names only, never a value. */
  readonly warn?: (message: string) => void
  /** The `security` binary, for the old keychain items (tests point this at a fake). */
  readonly security?: string
}

export const SECRETS_DIR_NAME = 'secrets'

/** A tmp file older than this was left by a crash; younger, it may be in flight. */
export const STALE_TMP_MS = 60_000

const assertName = (name: string): void => {
  if (!isSecretName(name)) {
    throw new Error(`not a secret name: lower-case letters, digits and dashes, up to 64, never a leading dash`)
  }
}

/** What the file holds: `sealed` (base64 ciphertext), or from older versions the value, or a `keychain` mark. */
type StoredRecord = Partial<SecretRecord> & { sealed?: string; keychain?: boolean }

const parseStored = (raw: string): StoredRecord | null => {
  try {
    const parsed = JSON.parse(raw) as StoredRecord
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

const parseRecord = (raw: string): SecretRecord | null => {
  try {
    const parsed = JSON.parse(raw) as Partial<SecretRecord>
    if (typeof parsed.value !== 'string') return null
    return {
      value: parsed.value,
      served: parsed.served === true,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : 0,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0
    }
  } catch {
    return null
  }
}

export const createSecretsStore = (options: SecretsStoreOptions = {}): SecretsStore => {
  const dir = path.join(options.baseDir ?? path.join(homedir(), '.cookrew'), SECRETS_DIR_NAME)
  const now = options.now ?? ((): number => Date.now())
  const { sealer, requireSealer = false } = options
  const warn = options.warn ?? ((): void => undefined)
  const security = options.security ?? 'security'

  /** `security …` with the value never on stdout of this process. */
  const securityRun = (args: string[]): string =>
    execFileSync(security, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

  const keychainRead = (name: string): string | null => {
    try {
      return securityRun(['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', keychainService(name), '-w']).replace(/\n$/, '')
    } catch {
      return null
    }
  }
  const keychainRemove = (name: string): void => {
    try {
      securityRun(['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', keychainService(name)])
    } catch {
      // Nothing there: the file is the record of that.
    }
  }

  let leftOutOfBackups = false
  /** Said once a name: the scrub reads every value every few seconds. */
  const unopened = new Set<string>()

  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // A directory that already existed keeps whatever mode it had: say 0700 again.
    if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
    if (!leftOutOfBackups) {
      leftOutOfBackups = true
      options.excludeFromBackup?.(dir)
    }
  }

  const fileOf = (name: string): string => path.join(dir, name)

  const read = (name: string): SecretRecord | null => {
    assertName(name)
    let raw: string
    try {
      raw = readFileSync(fileOf(name), 'utf8')
    } catch {
      return null
    }
    const stored = parseStored(raw)
    if (typeof stored?.sealed === 'string') {
      // Sealed by another build holds another key, and a denied keychain holds
      // none. The file stays: a seal replaces it, and the right build opens it.
      try {
        if (!sealer) throw new Error('no sealer')
        return {
          value: valueIn(name, sealer.open(Buffer.from(stored.sealed, 'base64'))),
          served: stored.served === true,
          createdAt: typeof stored.createdAt === 'number' ? stored.createdAt : 0,
          updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : 0
        }
      } catch {
        if (!unopened.has(name)) {
          unopened.add(name)
          warn(`secret ${name} could not be opened: sealed by another build, or the keychain refused`)
        }
        return null
      }
    }
    if (stored?.keychain === true) {
      // The file is the facts; the keychain is the value. A file with no
      // keychain item behind it is a secret that is gone, not an empty one.
      const value = keychainRead(name)
      if (value === null || value.length === 0) return null
      return {
        value,
        served: stored.served === true,
        createdAt: typeof stored.createdAt === 'number' ? stored.createdAt : 0,
        updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : 0
      }
    }
    return parseRecord(raw)
  }

  /**
   * A `<name>.<pid>.tmp` left by a crash mid-write holds nothing anyone should
   * keep — but one that is seconds old may be another live writer's, so only
   * a file older than STALE_TMP_MS goes. Every put sweeps its own name first,
   * so a crash does not leave the next put throwing EEXIST until a list runs.
   */
  const sweepStale = (names: readonly string[]): void => {
    const cutoff = now() - STALE_TMP_MS
    for (const entry of names) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}\.\d+\.tmp$/.test(entry)) continue
      const file = path.join(dir, entry)
      try {
        if (statSync(file).mtimeMs > cutoff) continue
        rmSync(file)
      } catch {
        // Already gone, or not ours to remove.
      }
    }
  }

  const listeners = new Set<() => void>()
  const changed = (): void => {
    for (const listener of listeners) listener()
  }
  const onChange: SecretsStore['onChange'] = (listener) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }

  /** Whole, to a sibling, then renamed: a crash leaves the old file or the new one. */
  const writeRecord = (name: string, stored: StoredRecord): void => {
    const file = fileOf(name)
    const tmp = `${file}.${process.pid}.tmp`
    try {
      sweepStale(readdirSync(dir).filter((entry) => entry.startsWith(`${name}.`)))
    } catch {
      // The directory was just made: nothing to sweep.
    }
    // `wx`: create, never open an existing file, never follow a symlink that
    // was planted at this path — a value must land in a file this process
    // made with this mode, or nowhere. Then fsync, then rename into place.
    const fd = openSync(tmp, 'wx', 0o600)
    try {
      writeSync(fd, JSON.stringify(stored))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, file)
  }

  /** The ciphertext for a value, or the reason in words that hold no value. */
  const sealOf = (name: string, value: string): string => {
    try {
      return (sealer as SecretSealer).seal(sealedText(name, value)).toString('base64')
    } catch {
      throw new Error(`the keychain refused to seal ${name}: nothing was written`)
    }
  }

  const put: SecretsStore['put'] = (name, value, putOptions = {}) => {
    assertName(name)
    if (typeof value !== 'string' || value.length === 0) throw new Error('a secret needs a value')
    const sealing = sealer?.available() === true
    if (!sealing && requireSealer) throw new Error(`the keychain is not available: ${name} was not sealed`)
    ensureDir()
    const before = read(name)
    const at = now()
    const record: SecretRecord = {
      value,
      served: putOptions.served === true,
      createdAt: before?.createdAt ?? at,
      updatedAt: at
    }
    const stored: StoredRecord = sealing
      ? { sealed: sealOf(name, value), served: record.served, createdAt: record.createdAt, updatedAt: record.updatedAt }
      : record
    const hadKeychainItem = storedOf(name)?.keychain === true
    writeRecord(name, stored)
    if (hadKeychainItem) keychainRemove(name)
    unopened.delete(name)
    changed()
    return { name, served: record.served, updatedAt: record.updatedAt }
  }

  const storedOf = (name: string): StoredRecord | null => {
    try {
      return parseStored(readFileSync(fileOf(name), 'utf8'))
    } catch {
      return null
    }
  }

  const migrate: SecretsStore['migrate'] = () => {
    const sealed: string[] = []
    const failed: string[] = []
    if (!sealer?.available()) return { sealed, failed }
    ensureDir()
    const names = readdirSync(dir)
    // A write cut short by a crash may have left a value in a tmp file.
    sweepStale(names)
    for (const name of names.sort()) {
      if (!isSecretName(name)) continue
      const stored = storedOf(name)
      if (stored === null || typeof stored.sealed === 'string') continue
      try {
        const record = read(name)
        if (record === null) throw new Error('unreadable')
        const box = sealer.seal(sealedText(name, record.value))
        // The clear file goes only once these exact bytes have opened back.
        if (valueIn(name, sealer.open(box)) !== record.value) throw new Error('did not open back')
        writeRecord(name, { sealed: box.toString('base64'), served: record.served, createdAt: record.createdAt, updatedAt: record.updatedAt })
        if (stored.keychain === true) keychainRemove(name)
        sealed.push(name)
      } catch {
        failed.push(name)
      }
    }
    return { sealed, failed }
  }

  const list = (): SecretListing[] => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    sweepStale(names)
    const rows: SecretListing[] = []
    for (const name of names.sort()) {
      if (!isSecretName(name)) continue
      // The listing never needs the value, so it never opens one.
      let stored: StoredRecord | null
      try {
        stored = parseStored(readFileSync(fileOf(name), 'utf8'))
      } catch {
        continue
      }
      if (!stored || (stored.keychain !== true && typeof stored.value !== 'string' && typeof stored.sealed !== 'string')) continue
      rows.push({
        name,
        served: stored.served === true,
        updatedAt: typeof stored.updatedAt === 'number' ? stored.updatedAt : 0
      })
    }
    return rows
  }

  const remove = (name: string): boolean => {
    assertName(name)
    try {
      sweepStale(readdirSync(dir).filter((entry) => entry.startsWith(`${name}.`)))
    } catch {
      // No directory: nothing stale either.
    }
    let had = false
    try {
      had = parseStored(readFileSync(fileOf(name), 'utf8'))?.keychain === true
    } catch {
      // No file: nothing in the keychain was ever recorded for it either.
    }
    if (had) keychainRemove(name)
    try {
      rmSync(fileOf(name))
      changed()
      return true
    } catch {
      return false
    }
  }

  return { put, read, list, remove, migrate, onChange, dir }
}
