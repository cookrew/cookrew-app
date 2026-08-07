import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  loadOrCreatePairingToken,
  pairingTokenAge,
  pairingTokenFile,
  rotatePairingToken
} from '../src/main/pairing-token'

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'cookrew-pairing-'))
}

describe('loadOrCreatePairingToken', () => {
  it('mints a token on first use', () => {
    const dir = freshDir()
    const token = loadOrCreatePairingToken(dir)
    expect(token.length).toBeGreaterThanOrEqual(16)
    rmSync(dir, { recursive: true, force: true })
  })

  it('SURVIVES a restart — this is the whole point', () => {
    const dir = freshDir()
    const first = loadOrCreatePairingToken(dir)
    // A second app run reads the same file rather than minting a new token,
    // so a phone paired yesterday still works today.
    expect(loadOrCreatePairingToken(dir)).toBe(first)
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes the file owner-only — it authorizes every mutating route', () => {
    const dir = freshDir()
    loadOrCreatePairingToken(dir)
    const mode = statSync(pairingTokenFile(dir)).mode & 0o777
    expect(mode).toBe(0o600)
    rmSync(dir, { recursive: true, force: true })
  })

  it('replaces a truncated or empty file rather than serving a weak token', () => {
    const dir = freshDir()
    writeFileSync(pairingTokenFile(dir), 'short\n')
    const token = loadOrCreatePairingToken(dir)
    expect(token).not.toBe('short')
    expect(token.length).toBeGreaterThanOrEqual(16)
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not store a trailing newline in the token itself', () => {
    const dir = freshDir()
    const token = loadOrCreatePairingToken(dir)
    expect(token).toBe(readFileSync(pairingTokenFile(dir), 'utf8').trim())
    expect(token).not.toContain('\n')
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('rotatePairingToken', () => {
  it('invalidates the old token', () => {
    const dir = freshDir()
    const before = loadOrCreatePairingToken(dir)
    const after = rotatePairingToken(dir)
    expect(after).not.toBe(before)
    expect(loadOrCreatePairingToken(dir)).toBe(after)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('pairingTokenAge', () => {
  it('is null before a token exists and a date afterwards', () => {
    const dir = freshDir()
    expect(pairingTokenAge(dir)).toBeNull()
    loadOrCreatePairingToken(dir)
    expect(pairingTokenAge(dir)).toBeInstanceOf(Date)
    rmSync(dir, { recursive: true, force: true })
  })
})
