/**
 * WHAT KEEPS A SEALED VALUE TO THIS APP (secrets-store.ts).
 *
 * Electron's safeStorage holds one key in the keychain, as "<app name> Safe
 * Storage", and the ACL on that item names the app's code. Measured on a Mac
 * with a throwaway app, 2026-11-05:
 *
 *   the file                ciphertext; the value is not in it
 *   `security ... -w`       stops at the keychain's password prompt
 *   the app itself          no prompt
 *   ANOTHER SCRIPT ON THE SAME UNSIGNED ELECTRON   opens it, no prompt
 *
 * That last line is the limit of a dev run: the ACL is the binary's cdhash, and
 * `node_modules/electron` runs whatever it is pointed at. A signed build has its
 * own identity, and its fuses (scripts/after-pack-fuses.cjs) stop anything else
 * being run as it. So this is a wall against reading and against forgetting the
 * audit, not against code that sets out to run as Cookrew from a dev checkout.
 *
 * The key is per app name, so a dev run ("cookrew") and a packaged one
 * ("Cookrew") cannot open each other's values: the store says so by name and
 * leaves the file.
 */

import { execFile } from 'node:child_process'
import type { SecretSealer } from './secrets-store'

/** The slice of Electron's safeStorage this uses. */
export interface SafeStorageLike {
  isEncryptionAvailable: () => boolean
  encryptString: (value: string) => Buffer
  decryptString: (box: Buffer) => string
  /** Linux only. */
  getSelectedStorageBackend?: () => string
}

export function electronSealer(safe: SafeStorageLike, platform: NodeJS.Platform = process.platform): SecretSealer {
  return {
    available: () => {
      try {
        // Linux with no keyring falls back to a key written in Chromium's source.
        if (platform === 'linux' && safe.getSelectedStorageBackend?.() === 'basic_text') return false
        return safe.isEncryptionAvailable()
      } catch {
        return false
      }
    },
    seal: (value) => safe.encryptString(value),
    open: (box) => safe.decryptString(box)
  }
}

export interface BackupExclusionDeps {
  platform?: NodeJS.Platform
  run?: (bin: string, args: string[]) => void
  warn?: (message: string) => void
}

/**
 * Time Machine leaves the directory out. Ciphertext would be safe in a backup,
 * but a restored file is only as good as the key beside it, and a value the
 * owner rotated should not live on in an old snapshot.
 */
export function excludeFromBackup(dir: string, deps: BackupExclusionDeps = {}): void {
  const { platform = process.platform, warn = (): void => undefined } = deps
  if (platform !== 'darwin') return
  const say = (): void => warn('secrets: could not keep the directory out of the backups')
  const run =
    deps.run ??
    ((bin: string, args: string[]): void => {
      execFile(bin, args, (error) => {
        if (error) say()
      })
    })
  try {
    run('tmutil', ['addexclusion', dir])
  } catch {
    say()
  }
}
