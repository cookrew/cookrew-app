import { hkdfSync, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { SEAL_CODE_BYTES, SEAL_LABEL } from '../shared/canvas-seal'
import { writeFileAtomic } from './atomic-file'

/**
 * THE CONNECT CODE: what a phone proves in the sealed session's handshake.
 *
 * It reaches a phone in a pairing link's fragment, or sealed to that phone's key,
 * and nowhere else. That is why it cannot be the pairing token, which has crossed
 * the relay in the clear on every request until now: the relay may have seen it.
 *
 * One per Mac, rotated with the pairing token, so `cookrew mobile --rotate` is
 * still the one way to shut every phone out. The file is 0600 and denied to served
 * seats (owner-secrets.ts); an agent of the owner's own can read it, as it can the
 * pairing token.
 */

export interface ConnectCodes {
  /** For a pairing link. */
  encoded(): string
  /** The code a hello names, or null: there is only ever this one. */
  codeFor(id: string): Uint8Array | null
  rotate(): void
}

const idOf = (code: Buffer): string => Buffer.from(hkdfSync('sha256', code, Buffer.alloc(0), `${SEAL_LABEL} id`, 16)).toString('base64url')

function mint(file: string): Buffer {
  const code = randomBytes(SEAL_CODE_BYTES)
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileAtomic(file, `${code.toString('base64url')}\n`)
    chmodSync(file, 0o600)
  } catch (error) {
    // Held in memory for this run: phones rescan after a restart, nothing worse.
    console.error('Failed to persist the connect code:', error)
  }
  return code
}

function loadOrMint(file: string): Buffer {
  try {
    const held = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64url')
    if (held.length === SEAL_CODE_BYTES) return held
  } catch {
    // None yet.
  }
  return mint(file)
}

export function createConnectCodes(file: string): ConnectCodes {
  let code = loadOrMint(file)
  let id = idOf(code)
  return {
    encoded: () => code.toString('base64url'),
    codeFor: (asked) => (asked === id ? new Uint8Array(code) : null),
    rotate() {
      code = mint(file)
      id = idOf(code)
    }
  }
}
