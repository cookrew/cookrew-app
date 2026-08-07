// The read-only token is a SCOPE, not a second interface: it authorizes GETs
// on the same routes the pairing token covers. What matters here is that it is
// a real, persistent, owner-only credential — a TV paired once must keep
// working across restarts without ever gaining write authority.

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadOrCreateReadOnlyToken, readOnlyTokenFile } from '../src/main/readonly-token'

describe('read-only token', () => {
  it('creates a persistent 0600 token file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ro-'))
    const token = loadOrCreateReadOnlyToken(dir)
    expect(token.length).toBeGreaterThanOrEqual(16)
    const file = readOnlyTokenFile(dir)
    expect(readFileSync(file, 'utf8').trim()).toBe(token)
    // Windows has no POSIX mode bits; the guarantee under test is a
    // POSIX one, so assert it where it exists rather than faking it.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('reuses an existing token so a paired screen survives restarts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ro-'))
    const first = loadOrCreateReadOnlyToken(dir)
    expect(loadOrCreateReadOnlyToken(dir)).toBe(first)
  })

  it('regenerates when the stored token is unusably short', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ro-'))
    writeFileSync(readOnlyTokenFile(dir), 'tiny\n', 'utf8')
    expect(loadOrCreateReadOnlyToken(dir).length).toBeGreaterThanOrEqual(16)
  })

  it('keeps the historical wall-token path so existing pairings survive', () => {
    expect(readOnlyTokenFile('/base')).toBe(path.join('/base', 'wall-token'))
  })
})
