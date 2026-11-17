import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  CREATE_PRIVATE_SCRIPT,
  READ_FILE_SCRIPT,
  READ_FOLDER_SCRIPT,
  parseDescriptor,
  parseReport,
  powershellArgs,
  runPowershellWith,
  privacyProblem,
  sidText
} from '../src/main/windows-acl'
import { ACE_ALLOWED, ACE_DENIED, INHERIT_ONLY, ace, acl, descriptor, sid } from './support/security-descriptor'

const ME = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1002'
const SYSTEM = 'S-1-5-18'
const ADMINS = 'S-1-5-32-544'
const EVERYONE = 'S-1-1-0'
const USERS = 'S-1-5-32-545'
const AUTHENTICATED = 'S-1-5-11'

/** The list writePrivateFile sets: protected, the user, SYSTEM and Administrators. */
const PRIVATE = acl([ace(ACE_ALLOWED, SYSTEM), ace(ACE_ALLOWED, ADMINS), ace(ACE_ALLOWED, ME)])

const problem = (bytes: Buffer, user = ME): string | null => privacyProblem(parseDescriptor(bytes), user)

describe('sidText', () => {
  it('reads a SID the way Windows prints it', () => {
    expect(sidText(sid(ME), 0)).toEqual({ text: ME, length: 28 })
    expect(sidText(sid(SYSTEM), 0)).toEqual({ text: SYSTEM, length: 12 })
  })
})

describe('privacyProblem: who owns the file and who the list lets in', () => {
  it('is private when only this user, SYSTEM and Administrators hold a grant, owned by one of them', () => {
    for (const owner of [ME, SYSTEM, ADMINS]) {
      expect(problem(descriptor({ owner, group: OTHER, dacl: PRIVATE, protectedDacl: true }))).toBeNull()
    }
  })

  it('is open when ANYONE else owns it: an owner can rewrite the list whatever it says', () => {
    expect(problem(descriptor({ owner: OTHER, dacl: PRIVATE }))).toMatch(new RegExp(`owned by ${OTHER}`))
    expect(problem(descriptor({ owner: USERS, dacl: PRIVATE }))).toMatch(/owned by/)
  })

  it('is open when the list lets anyone else in: a file moved in from Public keeps that list', () => {
    for (const stranger of [EVERYONE, USERS, AUTHENTICATED, OTHER]) {
      const open = acl([ace(ACE_ALLOWED, ME), ace(ACE_ALLOWED, stranger, { mask: 0x120089 })])
      expect(problem(descriptor({ owner: ME, dacl: open }))).toBe(`it lets ${stranger} in`)
    }
  })

  it('a deny never widens it, and an inherit-only entry is not about this file', () => {
    const dacl = acl([ace(ACE_DENIED, EVERYONE), ace(ACE_ALLOWED, EVERYONE, { flags: INHERIT_ONLY }), ace(ACE_ALLOWED, ME)])
    expect(problem(descriptor({ owner: ME, dacl }))).toBeNull()
  })

  it('is open with a NULL list (everyone) and with no list at all', () => {
    expect(problem(descriptor({ owner: ME, dacl: null }))).toMatch(/NULL access list/)
    expect(problem(descriptor({ owner: ME }))).toMatch(/no access list/)
  })

  it('the built-in Administrator account (RID 500) is trusted only when it IS this user', () => {
    const localAdmin = 'S-1-5-21-1111111111-2222222222-3333333333-500'
    const theirs = descriptor({ owner: localAdmin, dacl: acl([ace(ACE_ALLOWED, localAdmin)]) })
    expect(problem(theirs, localAdmin)).toBeNull()
    expect(problem(theirs, ME)).toMatch(/owned by/)
  })
})

describe('parseDescriptor FAILS CLOSED on anything it cannot account for, byte for byte', () => {
  const good = (): Buffer => descriptor({ owner: ME, group: ME, dacl: PRIVATE, protectedDacl: true })

  it('reads a well-formed descriptor', () => {
    const parsed = parseDescriptor(good())
    expect(parsed.owner).toBe(ME)
    expect(parsed.dacl).toMatchObject({ kind: 'list' })
  })

  it('refuses bytes after the last section', () => {
    expect(() => parseDescriptor(descriptor({ owner: ME, dacl: PRIVATE, tail: Buffer.from([0, 0, 0, 0]) }))).toThrow(/unaccounted/)
  })

  it('refuses an access list with slack after its entries', () => {
    expect(() => parseDescriptor(descriptor({ owner: ME, dacl: acl([ace(ACE_ALLOWED, ME)], { slack: 4 }) }))).toThrow(/access list/)
  })

  it('refuses an entry type it does not know (object, callback, conditional)', () => {
    const odd = ace(ACE_ALLOWED, EVERYONE)
    for (const type of [5, 9, 11]) {
      odd.writeUInt8(type, 0)
      expect(() => parseDescriptor(descriptor({ owner: ME, dacl: acl([ace(ACE_ALLOWED, ME), odd]) }))).toThrow(/entry type/)
    }
  })

  it('refuses an entry whose size disagrees with its SID', () => {
    const bad = ace(ACE_ALLOWED, ME)
    bad.writeUInt16LE(bad.length + 4, 2)
    expect(() => parseDescriptor(descriptor({ owner: ME, dacl: acl([bad]) }))).toThrow()
  })

  it('refuses a descriptor cut short anywhere', () => {
    const whole = good()
    for (let cut = 1; cut < whole.length; cut += 7) expect(() => parseDescriptor(whole.subarray(0, cut))).toThrow()
  })

  it('refuses a descriptor with no owner, a wrong revision, or one that is not self-relative', () => {
    expect(() => parseDescriptor(descriptor({ dacl: PRIVATE }))).toThrow(/owner/)
    const revision = good()
    revision.writeUInt8(2, 0)
    expect(() => parseDescriptor(revision)).toThrow(/revision/)
    expect(() => parseDescriptor(descriptor({ owner: ME, dacl: PRIVATE, control: 0x0004 }))).toThrow(/self-relative/)
  })

  it('refuses sections that overlap', () => {
    const bytes = good()
    bytes.writeUInt32LE(bytes.readUInt32LE(4), 8)
    expect(() => parseDescriptor(bytes)).toThrow()
  })
})

describe('privacyProblem for the FOLDER a secret is written into', () => {
  const folder = (...aces: Buffer[]) => parseDescriptor(descriptor({ owner: ME, dacl: acl([ace(ACE_ALLOWED, ME), ace(ACE_ALLOWED, SYSTEM), ...aces]) }))

  it('counts what a new file would inherit: an inherit-only grant to anyone else is a reason', () => {
    const passesOn = folder(ace(ACE_ALLOWED, USERS, { flags: INHERIT_ONLY | 0x01 }))
    expect(privacyProblem(passesOn, ME)).toBeNull()
    expect(privacyProblem(passesOn, ME, { container: true })).toBe(`it lets ${USERS} in`)
  })

  it('lets Creator Owner pass on: a new file’s owner is this process, checked anyway', () => {
    expect(privacyProblem(folder(ace(ACE_ALLOWED, 'S-1-3-0', { flags: INHERIT_ONLY | 0x03 })), ME, { container: true })).toBeNull()
    // Not on the folder ITSELF: there it would name whoever owns the folder.
    expect(privacyProblem(folder(ace(ACE_ALLOWED, 'S-1-3-0')), ME, { container: true })).toBe('it lets S-1-3-0 in')
  })
})

describe('the PowerShell it runs', () => {
  const scripts = [READ_FILE_SCRIPT, READ_FOLDER_SCRIPT, CREATE_PRIVATE_SCRIPT]

  it('is a constant -Command script: no path, no name, nothing spliced in', () => {
    for (const script of scripts) {
      expect(powershellArgs(script)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script])
      expect(script).toContain('$env:COOKREW_ACL_PATH')
      // No double quote: the Windows command line hands -Command its script unchanged.
      expect(script).not.toContain('"')
      expect(script).toMatch(/^\$ErrorActionPreference = 'Stop'; /)
    }
  })

  it('builds its .NET objects with ::new, not New-Object (which autoloads a module from PSModulePath)', () => {
    for (const script of scripts) expect(script).not.toMatch(/New-Object/i)
    expect(CREATE_PRIVATE_SCRIPT).toContain('[System.Security.AccessControl.FileSecurity]::new()')
    expect(CREATE_PRIVATE_SCRIPT).toContain('[System.IO.FileStream]::new($env:COOKREW_ACL_PATH, ')
  })

  it('reads through .NET, so no module has to load', () => {
    expect(READ_FILE_SCRIPT).toContain('[System.IO.File]::GetAccessControl($env:COOKREW_ACL_PATH)')
    expect(READ_FOLDER_SCRIPT).toContain('[System.IO.Directory]::GetAccessControl($env:COOKREW_ACL_PATH)')
    for (const script of scripts) expect(script).not.toMatch(/Get-Acl|Set-Acl/)
  })

  it('creates the file WITH its list (CreateNew + FileSecurity) and writes stdin through that handle', () => {
    expect(CREATE_PRIVATE_SCRIPT).toContain('[System.IO.FileMode]::CreateNew')
    expect(CREATE_PRIVATE_SCRIPT).toMatch(/\[System\.IO\.FileStream\]::new\(\$env:COOKREW_ACL_PATH, .*, \$acl\)/)
    expect(CREATE_PRIVATE_SCRIPT).toContain("'D:P(A;;FA;;;' + $me + ')(A;;FA;;;SY)(A;;FA;;;BA)'")
    expect(CREATE_PRIVATE_SCRIPT).toContain('[Console]::In.ReadToEnd()')
    expect(CREATE_PRIVATE_SCRIPT.indexOf('$fs.Write(')).toBeLessThan(CREATE_PRIVATE_SCRIPT.indexOf('GetAccessControl'))
  })
})

describe('parseReport', () => {
  it('takes a SID line and a base64 descriptor line, and nothing less', () => {
    const bytes = descriptor({ owner: ME, dacl: PRIVATE })
    expect(parseReport(`${ME}\r\n${bytes.toString('base64')}\r\n`)).toEqual({ userSid: ME, descriptor: bytes })
    expect(() => parseReport(`not-a-sid\r\n${bytes.toString('base64')}`)).toThrow(/SID/)
    expect(() => parseReport(`${ME}\r\n`)).toThrow(/descriptor/)
    expect(() => parseReport(`${ME}\r\nWARNING: something`)).toThrow(/descriptor/)
  })
})

describe('a PowerShell that overruns its time', () => {
  /** A child that takes `exitAfterKillMs` to let go of its handles once killed. */
  const slowChild = (exitAfterKillMs: number) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      killed: false,
      kill: () => {
        child.killed = true
        setTimeout(() => child.emit('close', null), exitAfterKillMs)
        return true
      }
    })
    return child
  }

  it('is killed, and the call settles only once it has EXITED: its handle on the temp is gone by then', async () => {
    const child = slowChild(40)
    let closedAt = 0
    child.on('close', () => (closedAt = Date.now()))
    const started = Date.now()
    const failure = await runPowershellWith({ spawn: () => child as never, timeoutMs: 10 }, READ_FILE_SCRIPT, 'C:\\k').catch((error: Error) => error)
    expect(child.killed).toBe(true)
    expect(String(failure)).toMatch(/took over 10 ms/)
    expect(closedAt).toBeGreaterThan(0)
    expect(Date.now()).toBeGreaterThanOrEqual(closedAt)
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
  })

  it('still settles if a killed child never says it closed', async () => {
    const child = slowChild(60_000)
    const failure = await runPowershellWith({ spawn: () => child as never, timeoutMs: 10, killGraceMs: 20 }, READ_FILE_SCRIPT, 'C:\\k').catch((error: Error) => error)
    expect(String(failure)).toMatch(/took over 10 ms/)
  })
})
