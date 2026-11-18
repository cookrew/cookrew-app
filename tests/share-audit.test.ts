// THE SHARE-KEYS AUDIT (Relay's ruling (a), review H2): every intent ShareKeys clears or keeps on its own
// is written to a file of its own, appended and synced, 0600 — never only to stderr, which a packaged
// app started from Finder sends nowhere.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileAuditLog, SHARE_AUDIT_FILE } from '../src/main/route/share-audit'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'share-audit-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the share-keys audit file', () => {
  it('appends one stamped line per entry, keeps earlier ones, and is 0600', () => {
    const file = path.join(dir, 'nested', SHARE_AUDIT_FILE)
    const audit = fileAuditLog(file, () => new Date('2026-11-19T06:00:00.000Z'))
    audit('share keys: first')
    audit('share keys: second')
    expect(readFileSync(file, 'utf8')).toBe('2026-11-19T06:00:00.000Z share keys: first\n2026-11-19T06:00:00.000Z share keys: second\n')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('keeps one entry to one line: a newline in it cannot forge another entry', () => {
    const file = path.join(dir, SHARE_AUDIT_FILE)
    fileAuditLog(file, () => new Date(0))('share keys: a\n1970-01-01T00:00:00.000Z forged')
    expect(readFileSync(file, 'utf8').trimEnd().split('\n')).toHaveLength(1)
  })

  it('tightens a file that was left readable to others', () => {
    const file = path.join(dir, SHARE_AUDIT_FILE)
    writeFileSync(file, 'old\n', { mode: 0o644 })
    fileAuditLog(file)('share keys: x')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8').startsWith('old\n')).toBe(true)
  })

  it('throws when it cannot write, so the caller can say so elsewhere', () => {
    writeFileSync(path.join(dir, 'blocked'), 'a file, not a folder')
    expect(() => fileAuditLog(path.join(dir, 'blocked', SHARE_AUDIT_FILE))('share keys: x')).toThrow()
  })
})
