// THE SHARE-KEYS AUDIT (Relay's ruling (a), review H2): every intent ShareKeys clears or keeps on its own
// is written to a file of its own, appended and synced, private to this user — never only to stderr,
// which a packaged app started from Finder sends nowhere.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileAuditLog, SHARE_AUDIT_FILE } from '../src/main/route/share-audit'
import { FIRST_RETRY_MS, PrivacyCache, checkFilePrivacy, type FilePrivacyDeps, type WindowsAcl } from '../src/main/file-privacy'
import { ACE_ALLOWED, ace, acl, descriptor } from './support/security-descriptor'

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'share-audit-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the share-keys audit file', () => {
  it('appends one stamped line per entry, keeps earlier ones, and is private', async () => {
    const file = path.join(dir, 'nested', SHARE_AUDIT_FILE)
    const audit = fileAuditLog(file, () => new Date('2026-11-19T06:00:00.000Z'))
    await audit('share keys: first')
    await audit('share keys: second')
    expect(readFileSync(file, 'utf8')).toBe('2026-11-19T06:00:00.000Z share keys: first\n2026-11-19T06:00:00.000Z share keys: second\n')
    // Windows has no POSIX modes (stat says 0666 for everything): there the owner and access list are proven instead.
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    else expect((await checkFilePrivacy(file)).open).toBe(false)
  })

  it('keeps one entry to one line: a newline in it cannot forge another entry', async () => {
    const file = path.join(dir, SHARE_AUDIT_FILE)
    await fileAuditLog(file, () => new Date(0))('share keys: a\n1970-01-01T00:00:00.000Z forged')
    expect(readFileSync(file, 'utf8').trimEnd().split('\n')).toHaveLength(1)
  })

  it.skipIf(process.platform === 'win32')('tightens a file that was left readable to others', async () => {
    const file = path.join(dir, SHARE_AUDIT_FILE)
    writeFileSync(file, 'old\n', { mode: 0o644 })
    await fileAuditLog(file)('share keys: x')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8').startsWith('old\n')).toBe(true)
  })

  it('rejects when it cannot write, so the caller can say so elsewhere', async () => {
    writeFileSync(path.join(dir, 'blocked'), 'a file, not a folder')
    await expect(fileAuditLog(path.join(dir, 'blocked', SHARE_AUDIT_FILE))('share keys: x')).rejects.toThrow()
  })
})

// WINDOWS, ON ANY OS: the log's owner and access list are faked (file-privacy.ts · WindowsAcl).
const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const EVERYONE = 'S-1-1-0'
const PRIVATE = descriptor({
  owner: ME,
  dacl: acl([ace(ACE_ALLOWED, ME), ace(ACE_ALLOWED, 'S-1-5-18'), ace(ACE_ALLOWED, 'S-1-5-32-544')]),
  protectedDacl: true
})
const OPEN = descriptor({ owner: ME, dacl: acl([ace(ACE_ALLOWED, ME), ace(ACE_ALLOWED, EVERYONE)]) })

function fakeWindows(over: { read?: () => Buffer; created?: () => Buffer } = {}) {
  const created: Array<{ file: string; data: string }> = []
  const windows: WindowsAcl = {
    read: async () => ({ userSid: ME, descriptor: (over.read ?? (() => PRIVATE))() }),
    readFolder: async () => ({ userSid: ME, descriptor: PRIVATE }),
    createPrivate: async (at, data) => {
      writeFileSync(at, data, { flag: 'wx' })
      created.push({ file: at, data: data.toString('utf8') })
      return { userSid: ME, descriptor: (over.created ?? (() => PRIVATE))() }
    }
  }
  return { windows, created }
}

const onWindows = (windows: WindowsAcl): FilePrivacyDeps => ({ platform: 'win32', windows, cache: new PrivacyCache() })
const at = (): Date => new Date('2026-11-19T06:00:00.000Z')

describe('the share-keys audit file on Windows: private by its owner and access list', () => {
  it('creates the log through the private path with its first entry, then appends to it while it is proven', async () => {
    const fake = fakeWindows()
    const file = path.join(dir, 'nested', SHARE_AUDIT_FILE)
    const audit = fileAuditLog(file, at, onWindows(fake.windows))
    await audit('share keys: first')
    expect(fake.created).toHaveLength(1)
    expect(path.dirname(fake.created[0].file)).toBe(path.dirname(file))
    expect(fake.created[0].data).toBe('2026-11-19T06:00:00.000Z share keys: first\n')
    await audit('share keys: second')
    expect(fake.created).toHaveLength(1)
    expect(readFileSync(file, 'utf8')).toBe('2026-11-19T06:00:00.000Z share keys: first\n2026-11-19T06:00:00.000Z share keys: second\n')
  })

  it('writes entries in the order they were asked for, even when called without waiting', async () => {
    const file = path.join(dir, SHARE_AUDIT_FILE)
    const audit = fileAuditLog(file, at, onWindows(fakeWindows().windows))
    await Promise.all(['a', 'b', 'c'].map((name) => audit(`share keys: ${name}`)))
    expect(readFileSync(file, 'utf8').trimEnd().split('\n').map((line) => line.split(' ').at(-1))).toEqual(['a', 'b', 'c'])
  })

  it('REFUSES to append to a log not proven private: it rejects and writes nothing there', async () => {
    const file = path.join(dir, SHARE_AUDIT_FILE)
    writeFileSync(file, 'old\n')
    const audit = fileAuditLog(file, at, onWindows(fakeWindows({ read: () => OPEN }).windows))
    await expect(audit('share keys: x')).rejects.toThrow(/not private/)
    expect(readFileSync(file, 'utf8')).toBe('old\n')
  })

  it('REFUSES a first entry whose new log does not prove private, and leaves no log behind', async () => {
    const file = path.join(dir, SHARE_AUDIT_FILE)
    const audit = fileAuditLog(file, at, onWindows(fakeWindows({ created: () => OPEN }).windows))
    await expect(audit('share keys: x')).rejects.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('a refused entry does not stop the next one, once the log is proven', async () => {
    const file = path.join(dir, SHARE_AUDIT_FILE)
    writeFileSync(file, 'old\n')
    let reads = 0
    let now = 1_000
    const deps: FilePrivacyDeps = { ...onWindows(fakeWindows({ read: () => (reads++ === 0 ? OPEN : PRIVATE) }).windows), now: () => now }
    const audit = fileAuditLog(file, at, deps)
    await expect(audit('share keys: refused')).rejects.toThrow()
    // A refusal is remembered with a back-off; once it has passed, the log is asked again.
    now += FIRST_RETRY_MS
    await audit('share keys: kept')
    expect(readFileSync(file, 'utf8')).toBe('old\n2026-11-19T06:00:00.000Z share keys: kept\n')
  })
})
