// Read-only credential for the mobile/TV surface.
//
// WHY A SECOND TOKEN, NOW THAT THERE IS ONLY ONE API
// --------------------------------------------------
// This is a SCOPE, not a parallel interface. Both tokens authorize the same
// routes; they differ only in what they may do:
//
//   pairing token    read + every mutating route (terminal input, restore, …)
//   read-only token  GET only — any other method is 401
//
// The read-only URL gets pasted into a Home Assistant script and left on an
// always-on TV in a room, where it will end up in a photograph. That must not
// be equivalent to write access over the whole fleet, so it is a distinct,
// separately revocable secret — but it no longer implies a separate, degraded
// endpoint. Redaction now happens at the source (BoardRow.task.summary is
// truncated when it is built), which is why /api/wall and its projection are
// gone: there is nothing left for a second interface to strip.

import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

/** Persisted beside the other cookrew state; owner-read/write only. */
export function readOnlyTokenFile(baseDir?: string): string {
  // Path kept as `wall-token` on purpose: an already-paired TV keeps working.
  return path.join(baseDir ?? path.join(homedir(), '.cookrew'), 'wall-token')
}

/**
 * The read-only token, created on first use and reused thereafter so a screen
 * paired once survives restarts. Written 0600: it is a credential, even though
 * it only unlocks GETs.
 */
export function loadOrCreateReadOnlyToken(baseDir?: string): string {
  const file = readOnlyTokenFile(baseDir)
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing.length >= 16) return existing
    }
  } catch (error) {
    console.error('Failed to read read-only token, regenerating:', error)
  }
  const token = randomBytes(24).toString('base64url')
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
    chmodSync(file, 0o600)
  } catch (error) {
    console.error('Failed to persist read-only token (using in-memory only):', error)
  }
  return token
}
