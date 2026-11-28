/**
 * EVERY CARD'S LOGINS SURVIVE A CHROME RESTART.
 *
 * A card's Chrome keeps a persistent profile (`<userData>/interactive-browser/
 * <cardId>`), yet Chrome drops SESSION cookies — no expiry — at every start, by
 * design, whatever the profile says (`session.restore_on_startup` included;
 * measured 11-28, browser-card-login-persistence-2026-11-28.html). Aliyun's
 * login is session-only, so every app restart signed the owner out.
 *
 * So the card's cookies are read from its Chrome before it closes
 * (headless-browser-manager.ts · keepCookies), sealed with Electron's
 * safeStorage (the app's keychain key: secrets-seal.ts) and written beside the
 * profile as `cookrew-cookies.bin`, owner-only, temp file then rename. The next
 * Chrome for the card starts with them (card-cookie-restore.ts).
 *
 * The owner's decision (11-28): ON BY DEFAULT, FOR EVERY CARD AND EVERY SITE,
 * WITH NO EXCLUSION LIST. `forgetAll` is the one way out, kept for a future
 * settings toggle; it deletes the vaults and leaves every profile alone.
 *
 * Fail closed: no encryption means no file, never plaintext. Never a throw into
 * startup: a vault that cannot be read is no vault, said once.
 */

import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Dirent } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { browserProfilePath } from './browser-profile-store'
import { electronSealer, type SafeStorageLike } from './secrets-seal'
import { isExpired, vaultCookieFrom, type VaultCookie } from './card-cookie-shape'

export const VAULT_FILE = 'cookrew-cookies.bin'
const VAULT_FORMAT = 1
export const VAULT_MAX_BYTES = 4 * 1024 * 1024
export const VAULT_MAX_COOKIES = 5000
/** Sealing pads and tags: a file this much over the plaintext cap is not ours. */
const SEAL_SLACK_BYTES = 64 * 1024

export interface CardCookieVaultDeps {
  readonly safeStorage: SafeStorageLike
  /** Where each card's Chrome profile directory is (index.ts · browserProfileRoot). */
  readonly profileRoot: () => string
  readonly log?: (line: string) => void
  readonly now?: () => number
  readonly platform?: NodeJS.Platform
  readonly maxBytes?: number
  readonly maxCookies?: number
}

export type VaultSaveResult =
  | { readonly saved: number }
  | { readonly refused: 'no-encryption' | 'too-many' | 'too-large' | 'write-failed' | 'bad-card' }

export interface CardCookieVault {
  /** Keep this card's cookies (CDP Network.Cookie objects as Storage.getCookies gave them). */
  save(browserId: string, cookies: readonly unknown[]): VaultSaveResult
  /** The card's kept cookies, unexpired; null when there is no vault it can read. Never throws. */
  load(browserId: string): VaultCookie[] | null
  /** Delete every card's vault; profiles stay. How many were deleted. */
  forgetAll(): number
}

export function createCardCookieVault(deps: CardCookieVaultDeps): CardCookieVault {
  const log = deps.log ?? ((line: string): void => console.error(line))
  const now = deps.now ?? Date.now
  const maxBytes = deps.maxBytes ?? VAULT_MAX_BYTES
  const maxCookies = deps.maxCookies ?? VAULT_MAX_COOKIES
  const sealer = electronSealer(deps.safeStorage, deps.platform)
  const told = new Set<string>()

  const fileFor = (browserId: string): string | null => {
    try {
      return path.join(browserProfilePath(deps.profileRoot(), browserId), VAULT_FILE)
    } catch {
      return null
    }
  }

  /** A load failure is said once per card per run: a card restarts many times. */
  const tellOnce = (browserId: string, line: string): null => {
    if (!told.has(browserId)) {
      told.add(browserId)
      log(line)
    }
    return null
  }

  const save = (browserId: string, raw: readonly unknown[]): VaultSaveResult => {
    const file = fileFor(browserId)
    if (!file) return { refused: 'bad-card' }
    if (!sealer.available()) {
      log(`cookie vault: encryption is unavailable, so card ${browserId}'s cookies were not kept (no plaintext is ever written)`)
      return { refused: 'no-encryption' }
    }
    const cookies = raw.map(vaultCookieFrom).filter((c): c is VaultCookie => c !== null && !isExpired(c, now()))
    if (cookies.length > maxCookies) {
      removeQuietly(file)
      log(`cookie vault: card ${browserId} has ${cookies.length} cookies, over the cap of ${maxCookies}; none were kept`)
      return { refused: 'too-many' }
    }
    const body = JSON.stringify({ v: VAULT_FORMAT, cookies })
    const bytes = Buffer.byteLength(body, 'utf8')
    if (bytes > maxBytes) {
      removeQuietly(file)
      log(`cookie vault: card ${browserId}'s cookies are ${bytes} bytes, over the cap of ${maxBytes} bytes; none were kept`)
      return { refused: 'too-large' }
    }
    try {
      writeAtomically(file, sealer.seal(body))
    } catch (error) {
      log(`cookie vault: card ${browserId}'s cookies could not be written (${codeOf(error)})`)
      return { refused: 'write-failed' }
    }
    return { saved: cookies.length }
  }

  const load = (browserId: string): VaultCookie[] | null => {
    const file = fileFor(browserId)
    if (!file) return tellOnce(browserId, `cookie vault: ${JSON.stringify(browserId)} is not a card id; nothing restored`)
    let size: number
    try {
      const stat = lstatSync(file)
      if (!stat.isFile()) return tellOnce(browserId, `cookie vault: card ${browserId}'s vault is not a plain file; nothing restored`)
      size = stat.size
    } catch {
      return null // No vault yet: the card has never been closed with one. Not a failure.
    }
    if (size > maxBytes + SEAL_SLACK_BYTES) return tellOnce(browserId, `cookie vault: card ${browserId}'s vault is ${size} bytes, too large to read`)
    if (!sealer.available()) return tellOnce(browserId, `cookie vault: encryption is unavailable, so card ${browserId}'s vault cannot be read`)
    let body: string
    try {
      body = sealer.open(readFileSync(file))
    } catch {
      return tellOnce(browserId, `cookie vault: card ${browserId}'s vault could not be opened (corrupt, or sealed by another app name); nothing restored`)
    }
    const cookies = parseVault(body)
    if (!cookies) return tellOnce(browserId, `cookie vault: card ${browserId}'s vault is in an old or unknown format; nothing restored`)
    return cookies.filter((cookie) => !isExpired(cookie, now()))
  }

  const forgetAll = (): number => {
    const root = deps.profileRoot()
    let entries: Dirent[]
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      return 0
    }
    let forgotten = 0
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dir = path.join(root, entry.name)
      try {
        for (const name of readdirSync(dir)) {
          if (name !== VAULT_FILE && !name.startsWith(`${VAULT_FILE}.tmp-`)) continue
          rmSync(path.join(dir, name), { force: true })
          if (name === VAULT_FILE) forgotten += 1
        }
      } catch {
        // One unreadable profile does not stop the rest being forgotten.
      }
    }
    told.clear()
    return forgotten
  }

  return { save, load, forgetAll }
}

function parseVault(body: string): VaultCookie[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const { v, cookies } = parsed as { v?: unknown; cookies?: unknown }
  if (v !== VAULT_FORMAT || !Array.isArray(cookies)) return null
  return cookies.map(vaultCookieFrom).filter((c): c is VaultCookie => c !== null)
}

function writeAtomically(file: string, bytes: Buffer): void {
  const temp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' })
    renameSync(temp, file)
  } catch (error) {
    removeQuietly(temp)
    throw error
  }
}

function removeQuietly(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    // Best effort: the next save replaces it.
  }
}

/** An fs error's code, never its message: the path is the card's, the values are never in it, but keep the line short. */
function codeOf(error: unknown): string {
  return typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'error'
}
