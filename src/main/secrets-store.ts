/**
 * WHERE A SEALED SECRET LIVES: ~/.cookrew/secrets/<name>, one file each.
 *
 * The same discipline as ~/.cookrew/stripe.env: a directory nobody else can
 * list (0700), a file nobody else can read (0600), written whole to a
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
 * THE KEYCHAIN OPT-IN. With `COOKREW_SECRETS_KEYCHAIN=1` the VALUE lives in
 * the macOS login keychain as a generic password (account `cookrew`,
 * service `cookrew-secret-<name>`), and the per-name file keeps only the
 * facts the listing shows: served, createdAt, updatedAt, and that the
 * value is in the keychain. Files stay the default. Everything above the
 * store — the audit line, the served refusal, the routes — is the same.
 */
export const KEYCHAIN_ENV = 'COOKREW_SECRETS_KEYCHAIN'
export const KEYCHAIN_ACCOUNT = 'cookrew'
export const keychainService = (name: string): string => `cookrew-secret-${name}`


export interface SecretsStore {
  readonly put: (name: string, value: string, options?: { served?: boolean }) => SecretListing
  readonly read: (name: string) => SecretRecord | null
  readonly list: () => SecretListing[]
  readonly remove: (name: string) => boolean
  /** Fires after a put or a remove: the scrub drops its value table on it. */
  readonly onChange: (listener: () => void) => () => void
  readonly dir: string
}

export interface SecretsStoreOptions {
  readonly baseDir?: string
  readonly now?: () => number
  /** Values in the keychain rather than the file; default from COOKREW_SECRETS_KEYCHAIN. */
  readonly keychain?: boolean
  /** The `security` binary (tests point this at a fake). */
  readonly security?: string
  readonly env?: NodeJS.ProcessEnv
}

export const SECRETS_DIR_NAME = 'secrets'

/** A tmp file older than this was left by a crash; younger, it may be in flight. */
export const STALE_TMP_MS = 60_000

const assertName = (name: string): void => {
  if (!isSecretName(name)) {
    throw new Error(`not a secret name: lower-case letters, digits and dashes, up to 64, never a leading dash`)
  }
}

/** What the file holds: the record, or the record without its value when the keychain has it. */
type StoredRecord = Partial<SecretRecord> & { keychain?: boolean }

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
  const env = options.env ?? process.env
  const keychain = options.keychain ?? env[KEYCHAIN_ENV] === '1'
  const security = options.security ?? 'security'

  /** `security …` with the value never on stdout of this process. */
  const securityRun = (args: string[]): string =>
    execFileSync(security, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

  const keychainPut = (name: string, value: string): void => {
    // -U updates in place; the item is this app's own account+service pair.
    securityRun(['add-generic-password', '-U', '-a', KEYCHAIN_ACCOUNT, '-s', keychainService(name), '-w', value])
  }
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

  const ensureDir = (): void => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // A directory that already existed keeps whatever mode it had: say 0700 again.
    if ((statSync(dir).mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
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

  const put: SecretsStore['put'] = (name, value, putOptions = {}) => {
    assertName(name)
    if (typeof value !== 'string' || value.length === 0) throw new Error('a secret needs a value')
    ensureDir()
    const before = read(name)
    const at = now()
    const record: SecretRecord = {
      value,
      served: putOptions.served === true,
      createdAt: before?.createdAt ?? at,
      updatedAt: at
    }
    // Keychain: the value goes there FIRST, so a file that says "keychain"
    // never points at an item that was not written; the file then holds no
    // value at all.
    if (keychain) keychainPut(name, value)
    const stored: StoredRecord = keychain
      ? { keychain: true, served: record.served, createdAt: record.createdAt, updatedAt: record.updatedAt }
      : record
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
    changed()
    return { name, served: record.served, updatedAt: record.updatedAt }
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
      // The listing never needs the value, so it never asks the keychain.
      let stored: StoredRecord | null
      try {
        stored = parseStored(readFileSync(fileOf(name), 'utf8'))
      } catch {
        continue
      }
      if (!stored || (stored.keychain !== true && typeof stored.value !== 'string')) continue
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

  return { put, read, list, remove, onChange, dir }
}
