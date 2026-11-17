import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FIRST_RETRY_MS,
  PROVEN_FOR_MS,
  PrivacyCache,
  STALE_TEMP_MS,
  sweepStaleTemps,
  checkFilePrivacy,
  filePrivacy,
  movePrivateFile,
  writePrivateFile,
  writePrivateFileSync,
  type FileFacts,
  type FilePrivacyDeps,
  type WindowsAcl
} from '../src/main/file-privacy'
import { parseDescriptor, readWindowsSecurity } from '../src/main/windows-acl'
import { ACE_ALLOWED, INHERIT_ONLY, ace, acl, descriptor } from './support/security-descriptor'

const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002'
const EVERYONE = 'S-1-1-0'
const USERS = 'S-1-5-32-545'
const TRUSTED = [ace(ACE_ALLOWED, ME), ace(ACE_ALLOWED, 'S-1-5-18'), ace(ACE_ALLOWED, 'S-1-5-32-544')]
const PRIVATE = descriptor({ owner: ME, dacl: acl(TRUSTED), protectedDacl: true })
const OPEN = descriptor({ owner: ME, dacl: acl([ace(ACE_ALLOWED, ME), ace(ACE_ALLOWED, EVERYONE)]) })
/** A folder a new file would inherit Users' read from, though Users holds nothing on the folder itself. */
const LOOSE_FOLDER = descriptor({ owner: ME, dacl: acl([...TRUSTED, ace(ACE_ALLOWED, USERS, { flags: INHERIT_ONLY | 0x01 })]) })

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cookrew-privacy-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Windows as far as a file's owner and list go, with a hand on when each answer lands. */
function fakeWindows(over: { read?: () => Buffer; folder?: () => Buffer; created?: () => Buffer } = {}) {
  const asked: string[] = []
  const created: Array<{ file: string; data: string }> = []
  const windows: WindowsAcl = {
    read: async (file) => {
      asked.push(file)
      return { userSid: ME, descriptor: (over.read ?? (() => PRIVATE))() }
    },
    readFolder: async () => ({ userSid: ME, descriptor: (over.folder ?? (() => PRIVATE))() }),
    createPrivate: async (file, data) => {
      // CreateNew: the name must not exist; the data arrives with the file.
      writeFileSync(file, data, { flag: 'wx' })
      created.push({ file, data: data.toString('utf8') })
      return { userSid: ME, descriptor: (over.created ?? (() => PRIVATE))() }
    }
  }
  return { windows, asked, created }
}

const facts = (over: Partial<FileFacts> = {}): FileFacts => ({ mode: 0o100666, uid: 0, dev: 1, ino: 7, size: 3, mtimeMs: 10, ctimeMs: 10, ...over })

/** A Windows file that does not exist on this disk: its status and its clock injected. */
function windowsRig(over: Parameters<typeof fakeWindows>[0] = {}) {
  const fake = fakeWindows(over)
  let now = 1_000
  let status = facts()
  const deps: FilePrivacyDeps = { platform: 'win32', stat: () => status, windows: fake.windows, cache: new PrivacyCache(), now: () => now }
  return { ...fake, deps, tick: (ms: number) => (now += ms), touch: (f: Partial<FileFacts>) => (status = facts(f)) }
}
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('filePrivacy on a POSIX host', () => {
  const posix = (mode: number) => filePrivacy('/k', { platform: 'darwin', stat: () => facts({ mode }) })

  it('reads the group and other bits', () => {
    expect(posix(0o100600)).toEqual({ open: false })
    expect(posix(0o100640)).toMatchObject({ open: true, fix: 'chmod 600 it' })
    expect(posix(0o100604)).toMatchObject({ open: true, why: expect.stringMatching(/mode 604/) })
  })

  it('passes on what stat throws, so a missing file is still ENOENT to its caller', () => {
    const gone = Object.assign(new Error('nope'), { code: 'ENOENT' })
    expect(() => filePrivacy('/k', { platform: 'linux', stat: () => { throw gone } })).toThrow(gone)
  })
})

describe('filePrivacy on Windows NEVER WAITS: a remembered verdict, or PENDING while it is checked', () => {
  it('answers PENDING (refused) at once, checks in the background, then answers from memory', async () => {
    const rig = windowsRig()
    expect(filePrivacy('C:\\k', rig.deps)).toMatchObject({ open: true, pending: true })
    await settle()
    expect(filePrivacy('C:\\k', rig.deps)).toEqual({ open: false })
    expect(filePrivacy('C:\\k', rig.deps)).toEqual({ open: false })
    expect(rig.asked).toHaveLength(1)
  })

  it('asks again once the verdict has aged, and forgets it when the file changes at all', async () => {
    const rig = windowsRig()
    await checkFilePrivacy('C:\\k', rig.deps)
    rig.tick(PROVEN_FOR_MS + 1)
    expect(filePrivacy('C:\\k', rig.deps)).toEqual({ open: false })
    await settle()
    expect(rig.asked).toHaveLength(2)
    rig.touch({ ctimeMs: 99 })
    expect(filePrivacy('C:\\k', rig.deps)).toMatchObject({ pending: true })
  })

  it('remembers a refusal and backs off, rather than asking per request', async () => {
    const rig = windowsRig({ read: () => OPEN })
    expect(await checkFilePrivacy('C:\\k', rig.deps)).toMatchObject({ open: true, why: `it lets ${EVERYONE} in` })
    for (let i = 0; i < 20; i += 1) expect(filePrivacy('C:\\k', rig.deps)).toMatchObject({ why: `it lets ${EVERYONE} in` })
    expect(rig.asked).toHaveLength(1)
    rig.tick(FIRST_RETRY_MS)
    await checkFilePrivacy('C:\\k', rig.deps)
    expect(rig.asked).toHaveLength(2)
    rig.tick(FIRST_RETRY_MS)
    await checkFilePrivacy('C:\\k', rig.deps)
    expect(rig.asked).toHaveLength(2)
  })

  it('FAILS CLOSED when Windows cannot be asked, or answers with a descriptor it cannot account for', async () => {
    const cannot = windowsRig({ read: () => { throw new Error('PowerShell exited 1') } })
    expect(await checkFilePrivacy('C:\\k', cannot.deps)).toMatchObject({ open: true, why: expect.stringMatching(/could not be proven.*PowerShell exited 1/) })
    const tail = windowsRig({ read: () => descriptor({ owner: ME, dacl: acl([ace(ACE_ALLOWED, ME)]), tail: Buffer.alloc(4) }) })
    expect(await checkFilePrivacy('C:\\k', tail.deps)).toMatchObject({ open: true })
    const owned = windowsRig({ read: () => descriptor({ owner: OTHER, dacl: acl([ace(ACE_ALLOWED, ME)]) }) })
    expect(await checkFilePrivacy('C:\\k', owned.deps)).toMatchObject({ open: true, why: expect.stringMatching(/owned by/) })
  })

  it('still passes on what stat throws: a missing key is "none", not "open"', async () => {
    const gone = Object.assign(new Error('nope'), { code: 'ENOENT' })
    const deps = { ...windowsRig().deps, stat: () => { throw gone } }
    expect(() => filePrivacy('C:\\k', deps)).toThrow(gone)
    await expect(checkFilePrivacy('C:\\k', deps)).rejects.toBe(gone)
  })
})

describe('writePrivateFile on Windows: private from its first instant, in a folder nobody else can reach', () => {
  const onWindows = (windows: WindowsAcl): FilePrivacyDeps => ({ platform: 'win32', windows, cache: new PrivacyCache() })

  it('creates the file WITH its list and writes the secret through that one call, then proves it', async () => {
    const { windows, created, asked } = fakeWindows()
    const dir = scratch()
    const file = path.join(dir, 'k.jwk')
    await writePrivateFile(file, 'secret', onWindows(windows))
    expect(created).toHaveLength(1)
    expect(created[0].data).toBe('secret')
    expect(path.dirname(created[0].file)).toBe(dir)
    expect(asked).toEqual([file])
    expect(readFileSync(file, 'utf8')).toBe('secret')
    expect(readdirSync(dir)).toEqual(['k.jwk'])
  })

  it('REFUSES a folder others can reach, inherited entries included, before anything is created', async () => {
    for (const folder of [OPEN, LOOSE_FOLDER]) {
      const { windows, created } = fakeWindows({ folder: () => folder })
      const dir = scratch()
      await expect(writePrivateFile(path.join(dir, 'k.jwk'), 'secret', onWindows(windows))).rejects.toThrow(/its folder is not private/)
      expect(created).toEqual([])
      expect(readdirSync(dir)).toEqual([])
    }
  })

  it('REFUSES, leaving nothing, when what Windows kept is not private, or cannot be read', async () => {
    for (const created of [() => OPEN, () => { throw new Error('access denied') }]) {
      const { windows } = fakeWindows({ created })
      const dir = scratch()
      await expect(writePrivateFile(path.join(dir, 'k.jwk'), 'secret', onWindows(windows))).rejects.toThrow(/was not written/)
      expect(readdirSync(dir)).toEqual([])
    }
  })

  it('removes the file and REFUSES when it reads back open once in place', async () => {
    const { windows } = fakeWindows({ read: () => OPEN })
    const dir = scratch()
    await expect(writePrivateFile(path.join(dir, 'k.jwk'), 'secret', onWindows(windows))).rejects.toThrow(/was not written/)
    expect(readdirSync(dir)).toEqual([])
  })

  it('a file it wrote is remembered as proven: the next read does not wait', async () => {
    const { windows } = fakeWindows()
    const deps = onWindows(windows)
    const file = path.join(scratch(), 'k.jwk')
    await writePrivateFile(file, 'secret', deps)
    expect(filePrivacy(file, deps)).toEqual({ open: false })
  })
})

describe('writePrivateFileSync on POSIX: through the descriptor it created, checked on that descriptor', () => {
  it.skipIf(process.platform === 'win32')('writes it 0600 and the user’s own, in a folder made 0700, and leaves no temp behind', () => {
    const dir = path.join(scratch(), 'keys')
    const file = path.join(dir, 'k.jwk')
    writePrivateFileSync(file, '{"k":1}')
    expect(readFileSync(file, 'utf8')).toBe('{"k":1}')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(file).uid).toBe(process.getuid?.())
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readdirSync(dir)).toEqual(['k.jwk'])
    writePrivateFileSync(file, 'new')
    expect(readFileSync(file, 'utf8')).toBe('new')
  })

  it('REFUSES before writing when the descriptor is not this user’s, or not private', () => {
    for (const fstat of [() => facts({ mode: 0o100600, uid: 4242 }), () => facts({ mode: 0o100644, uid: 0 })]) {
      const dir = scratch()
      expect(() => writePrivateFileSync(path.join(dir, 'k.jwk'), 'secret', { platform: 'linux', uid: () => 0, fstat })).toThrow(/was not written/)
      expect(readdirSync(dir)).toEqual([])
    }
  })

  it('leaves alone, and REFUSES, a name that no longer holds the file it wrote', () => {
    const dir = scratch()
    const file = path.join(dir, 'k.jwk')
    const deps: FilePrivacyDeps = { platform: 'linux', uid: () => 0, fstat: () => facts({ mode: 0o100600, ino: 1 }), stat: () => facts({ mode: 0o100600, ino: 2 }) }
    expect(() => writePrivateFileSync(file, 'secret', deps)).toThrow(/not the file that was just written/)
    expect(existsSync(file)).toBe(true)
  })

  it('is POSIX only: Windows must not block', () => {
    expect(() => writePrivateFileSync(path.join(scratch(), 'k'), 'x', { platform: 'win32' })).toThrow(/POSIX only/)
  })
})

describe('movePrivateFile', () => {
  it('moves within its folder and proves the result; a move that does not prove is refused but KEPT', async () => {
    const dir = scratch()
    const from = path.join(dir, 'k.json.pending')
    writeFileSync(from, 'key')
    const good = fakeWindows()
    await movePrivateFile(from, path.join(dir, 'k.json'), { platform: 'win32', windows: good.windows, cache: new PrivacyCache() })
    expect(readFileSync(path.join(dir, 'k.json'), 'utf8')).toBe('key')
    writeFileSync(from, 'key2')
    const bad = fakeWindows({ read: () => OPEN })
    await expect(movePrivateFile(from, path.join(dir, 'k2.json'), { platform: 'win32', windows: bad.windows, cache: new PrivacyCache() })).rejects.toThrow(/not private after the move/)
    expect(readFileSync(path.join(dir, 'k2.json'), 'utf8')).toBe('key2')
  })

  it('refuses to move a secret to another folder', async () => {
    const from = path.join(scratch(), 'k')
    writeFileSync(from, 'x')
    await expect(movePrivateFile(from, path.join(scratch(), 'k'))).rejects.toThrow(/own folder/)
  })
})

describe('a write that is cut short never leaves a secret, or a short key, behind', () => {
  // The POSIX writer only: Windows writes through PowerShell's own handle.
  it.skipIf(process.platform === 'win32')('POSIX: loops until every byte is written, however few each write takes', () => {
    const file = path.join(scratch(), 'k.jwk')
    const secret = JSON.stringify({ k: 'x'.repeat(200) })
    let calls = 0
    writePrivateFileSync(file, secret, {
      write: (fd, buffer, offset, length) => {
        calls += 1
        return writeSync(fd, buffer, offset, Math.min(length, 7))
      }
    })
    expect(readFileSync(file, 'utf8')).toBe(secret)
    expect(calls).toBeGreaterThan(20)
  })

  it('WINDOWS: keeps the ORIGINAL error when the temp cannot be removed yet, and removes it once it can', async () => {
    const dir = scratch()
    const removals: string[] = []
    let refuse = true
    const windows: WindowsAcl = {
      read: async () => ({ userSid: ME, descriptor: PRIVATE }),
      readFolder: async () => ({ userSid: ME, descriptor: PRIVATE }),
      createPrivate: async (file) => {
        // PowerShell timed out after creating it; its handle may still hold the file.
        writeFileSync(file, 'secret')
        throw new Error('PowerShell took over 10000 ms')
      }
    }
    const remove = (file: string): void => {
      removals.push(file)
      if (refuse) {
        refuse = false
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      }
      rmSync(file, { force: true })
    }
    await expect(
      writePrivateFile(path.join(dir, 'k.jwk'), 'secret', { platform: 'win32', windows, cache: new PrivacyCache(), remove, removeRetryMs: 5 })
    ).rejects.toThrow(/PowerShell took over 10000 ms/)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(removals).toHaveLength(2)
    expect(readdirSync(dir)).toEqual([])
  })

  it('sweeps a stale temp left beside a credential, and nothing else', () => {
    const dir = scratch()
    const stale = path.join(dir, '.k.jwk.4242.0123456789ab.tmp')
    const fresh = path.join(dir, '.k.jwk.4243.ba9876543210.tmp')
    for (const [file, body] of [[stale, 's'], [fresh, 'f'], [path.join(dir, 'k.jwk'), 'key'], [path.join(dir, '.other.tmp'), 'o']]) writeFileSync(file, body)
    const old = (Date.now() - STALE_TEMP_MS - 60_000) / 1000
    utimesSync(stale, old, old)
    utimesSync(path.join(dir, '.other.tmp'), old, old)
    sweepStaleTemps(dir)
    expect(readdirSync(dir).sort()).toEqual(['.k.jwk.4243.ba9876543210.tmp', '.other.tmp', 'k.jwk'])
    expect(() => sweepStaleTemps(path.join(dir, 'missing'))).not.toThrow()
  })
})

// The real thing: PowerShell, .NET and NTFS, on the Windows CI runner.
describe.skipIf(process.platform !== 'win32')('owner and access list on a real Windows', () => {
  it('a secret written here is private: owned by a trusted account, the exact protected list', async () => {
    const file = path.join(scratch(), 'mine.jwk')
    await writePrivateFile(file, '{}')
    expect(await checkFilePrivacy(file)).toEqual({ open: false })
    const { userSid, descriptor: raw } = await readWindowsSecurity(file)
    const parsed = parseDescriptor(raw)
    expect(parsed.dacl.kind).toBe('list')
    const grants = parsed.dacl.kind === 'list' ? parsed.dacl.aces.filter((a) => a.type === 'allow').map((a) => a.sid).sort() : []
    expect(grants).toEqual([userSid, 'S-1-5-18', 'S-1-5-32-544'].sort())
    expect(readFileSync(file, 'utf8')).toBe('{}')
  }, 60_000)

  it('the same kind of file, once Everyone may read it, is open', async () => {
    const file = path.join(scratch(), 'shared.jwk')
    await writePrivateFile(file, '{}')
    // Everyone by its well-known SID: no account name is spelled anywhere.
    execFileSync('icacls', [file, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore' })
    expect(await checkFilePrivacy(file, { cache: new PrivacyCache() })).toMatchObject({ open: true, why: 'it lets S-1-1-0 in' })
  }, 60_000)

  // HOW LONG A REMEMBERED "PRIVATE" CAN OUTLIVE A LOOSENED LIST. The cache is
  // keyed on ctime among others; whether NTFS moves ChangeTime on a DACL change
  // decides whether the next read notices at once or only once the verdict
  // ages out. Either way it must be noticed within 2 × PROVEN_FOR_MS.
  it('a list loosened after a proof is noticed at once if ctime moves, and within 2 × PROVEN_FOR_MS if not', async () => {
    let now = 1_000_000
    const deps: FilePrivacyDeps = { cache: new PrivacyCache(), now: () => now }
    const file = path.join(scratch(), 'k.jwk')
    await writePrivateFile(file, '{}', deps)
    const before = statSync(file).ctimeMs
    execFileSync('icacls', [file, '/grant', '*S-1-1-0:(R)'], { stdio: 'ignore' })
    const moved = statSync(file).ctimeMs !== before
    // Recorded in the CI log: which bound this machine's NTFS gives.
    process.stdout.write(`NTFS ChangeTime moved on a DACL change: ${moved}\n`)
    const right = filePrivacy(file, deps)
    if (moved) expect(right).toMatchObject({ open: true })
    else expect(right).toEqual({ open: false })
    now += 2 * PROVEN_FOR_MS
    expect(filePrivacy(file, deps)).toMatchObject({ open: true })
    expect(await checkFilePrivacy(file, deps)).toMatchObject({ open: true, why: 'it lets S-1-1-0 in' })
  }, 60_000)

  it('a folder others can read is REFUSED for a secret, and a file inheriting its list is open', async () => {
    const loose = path.join(scratch(), 'public')
    mkdirSync(loose)
    // Users may read everything made in it, as in C:\Users\Public.
    execFileSync('icacls', [loose, '/grant', '*S-1-5-32-545:(OI)(CI)(R)'], { stdio: 'ignore' })
    const plain = path.join(loose, 'plain.jwk')
    writeFileSync(plain, '{}')
    expect(await checkFilePrivacy(plain)).toMatchObject({ open: true, why: 'it lets S-1-5-32-545 in' })
    await expect(writePrivateFile(path.join(loose, 'secret.jwk'), '{}')).rejects.toThrow(/its folder is not private/)
    expect(readdirSync(loose)).toEqual(['plain.jwk'])
  }, 60_000)
})
