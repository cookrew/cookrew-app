// The pairing credential, persisted across app runs.
//
// WHY IT PERSISTS NOW
// -------------------
// It used to be `randomUUID()` per run. That meant every desktop restart
// invalidated every paired phone at once, and because the renderer swallowed
// the resulting 401s, the phone did not say so — buttons simply stopped
// working. Re-pairing requires reading a URL off the desktop, so "re-pair on
// every restart" is not a workflow anyone follows; they just stop using the
// phone.
//
// The read-only (wall) token already persists for the same reason, so this is
// the codebase's existing answer rather than a new posture.
//
// THE TRADE-OFF, STATED PLAINLY: a token that outlives the process is a token
// a leaked screenshot keeps unlocking — and with a tailnet endpoint that URL
// now works from outside the house. `rotatePairingToken()` is the answer to
// that, and `cookrew mobile --rotate` is how a user reaches it.

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Persisted beside the other cookrew state; owner-read/write only. */
export function pairingTokenFile(baseDir?: string): string {
  return path.join(baseDir ?? path.join(homedir(), '.cookrew'), 'pairing-token')
}

function mint(file: string): string {
  const token = randomBytes(24).toString('base64url')
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(file, 0o600)
  } catch (error) {
    console.error('Failed to persist pairing token (using in-memory only):', error)
  }
  return token
}

/**
 * The pairing token, created on first use and reused thereafter so a phone
 * paired once survives restarts. Written 0600 — it authorizes every mutating
 * route on the companion.
 */
export function loadOrCreatePairingToken(baseDir?: string): string {
  const file = pairingTokenFile(baseDir)
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing.length >= 16) return existing
    }
  } catch (error) {
    console.error('Failed to read pairing token, regenerating:', error)
  }
  return mint(file)
}

/** Replace the token, invalidating every paired device. Returns the new one. */
export function rotatePairingToken(baseDir?: string): string {
  return mint(pairingTokenFile(baseDir))
}

/** When the current token was minted; null if it has never been written. */
export function pairingTokenAge(baseDir?: string): Date | null {
  try {
    const file = pairingTokenFile(baseDir)
    return existsSync(file) ? statSync(file).mtime : null
  } catch {
    return null
  }
}
