import { spawn } from 'node:child_process'
import path from 'node:path'

/**
 * WHO OWNS A WINDOWS FILE AND WHO ITS ACCESS LIST LETS IN.
 *
 * Windows has no POSIX permission bits, so "private to this user" is the
 * file's security descriptor: its OWNER (who may always rewrite the list) and
 * its DACL. Both are read as the binary self-relative descriptor, which names
 * every account by full SID in every locale (no aliases such as LA), and parsed
 * here byte by byte. Anything not accounted for is a reason to refuse.
 *
 * PowerShell (System32, -NoProfile, an argument array, never a shell) is the
 * one tool that hands over the binary form without a native module. The path
 * reaches it through an environment variable, never spliced into a command.
 */

/** This user, the machine itself, and its administrators: who may own or hold a grant on a private file. */
export const SYSTEM_SID = 'S-1-5-18'
export const ADMINISTRATORS_SID = 'S-1-5-32-544'

const SE_DACL_PRESENT = 0x0004
const SE_SELF_RELATIVE = 0x8000
const ACCESS_ALLOWED = 0
const ACCESS_DENIED = 1
const INHERIT_ONLY = 0x08
const HEADER = 20
const SID_PATTERN = /^S-1-\d+(-\d+)+$/

export interface Ace {
  readonly type: 'allow' | 'deny'
  readonly inheritOnly: boolean
  readonly sid: string
}

export type Dacl = { readonly kind: 'absent' } | { readonly kind: 'null' } | { readonly kind: 'list'; readonly aces: readonly Ace[] }

export interface Descriptor {
  readonly owner: string
  readonly group: string | null
  readonly dacl: Dacl
}

function need(ok: boolean, why: string): void {
  if (!ok) throw new Error(`security descriptor: ${why}`)
}

/** The SID at `at`, and how many bytes it took. Throws when it runs past `end`. */
export function sidText(bytes: Buffer, at: number, end = bytes.length): { text: string; length: number } {
  need(at + 8 <= end, 'a SID runs past its section')
  need(bytes.readUInt8(at) === 1, 'a SID has an unknown revision')
  const count = bytes.readUInt8(at + 1)
  need(count <= 15, 'a SID has too many parts')
  const length = 8 + 4 * count
  need(at + length <= end, 'a SID runs past its section')
  const authority = bytes.readUIntBE(at + 2, 6)
  const subs = Array.from({ length: count }, (_, i) => bytes.readUInt32LE(at + 8 + 4 * i))
  return { text: ['S', 1, authority, ...subs].join('-'), length }
}

/** An ACL at `at`: every entry read, and its size exactly the entries'. */
function aclAt(bytes: Buffer, at: number): { aces: Ace[]; length: number } {
  need(at + 8 <= bytes.length, 'the access list runs past the descriptor')
  const revision = bytes.readUInt8(at)
  need(revision === 2 || revision === 4, 'the access list has an unknown revision')
  const size = bytes.readUInt16LE(at + 2)
  const count = bytes.readUInt16LE(at + 4)
  const end = at + size
  need(size >= 8 && end <= bytes.length, 'the access list runs past the descriptor')
  const aces: Ace[] = []
  let p = at + 8
  for (let i = 0; i < count; i += 1) {
    need(p + 8 <= end, 'an access list entry runs past its list')
    const type = bytes.readUInt8(p)
    const flags = bytes.readUInt8(p + 1)
    const aceSize = bytes.readUInt16LE(p + 2)
    need(type === ACCESS_ALLOWED || type === ACCESS_DENIED, `an access list entry type it cannot read (${type})`)
    const who = sidText(bytes, p + 8, end)
    need(aceSize === 8 + who.length, 'an access list entry size disagrees with its SID')
    aces.push({ type: type === ACCESS_ALLOWED ? 'allow' : 'deny', inheritOnly: (flags & INHERIT_ONLY) !== 0, sid: who.text })
    p += aceSize
  }
  need(p === end, 'the access list has bytes after its entries')
  return { aces, length: size }
}

/**
 * A self-relative descriptor, as GetSecurityDescriptorBinaryForm returns it.
 * Throws on anything malformed or unaccounted for: every byte after the header
 * must belong to exactly one of the owner, group, SACL or DACL.
 */
export function parseDescriptor(bytes: Buffer): Descriptor {
  need(bytes.length >= HEADER, 'shorter than its header')
  need(bytes.readUInt8(0) === 1, 'an unknown revision')
  const control = bytes.readUInt16LE(2)
  need((control & SE_SELF_RELATIVE) !== 0, 'not self-relative')
  const [ownerAt, groupAt, saclAt, daclAt] = [4, 8, 12, 16].map((at) => bytes.readUInt32LE(at))
  const spans: Array<[number, number]> = []
  const span = (at: number, length: number): void => {
    need(at >= HEADER && at + length <= bytes.length, 'a section runs outside the descriptor')
    spans.push([at, at + length])
  }
  need(ownerAt !== 0, 'no owner')
  const owner = sidText(bytes, ownerAt)
  span(ownerAt, owner.length)
  let group: string | null = null
  if (groupAt !== 0) {
    const read = sidText(bytes, groupAt)
    span(groupAt, read.length)
    group = read.text
  }
  if (saclAt !== 0) span(saclAt, aclAt(bytes, saclAt).length)
  let dacl: Dacl = { kind: 'absent' }
  if ((control & SE_DACL_PRESENT) !== 0) {
    if (daclAt === 0) dacl = { kind: 'null' }
    else {
      const read = aclAt(bytes, daclAt)
      span(daclAt, read.length)
      dacl = { kind: 'list', aces: read.aces }
    }
  } else need(daclAt === 0, 'a DACL offset with no DACL present')
  spans.sort((a, b) => a[0] - b[0])
  let cursor = HEADER
  for (const [start, end] of spans) {
    need(start === cursor, start < cursor ? 'sections overlap' : 'bytes unaccounted for between sections')
    cursor = end
  }
  need(cursor === bytes.length, 'bytes unaccounted for after the last section')
  return { owner: owner.text, group, dacl }
}

/** Creator Owner: on an inheritable entry it becomes the NEW file's owner, who must be trusted anyway. */
const CREATOR_OWNER_SID = 'S-1-3-0'

/**
 * Why `descriptor` is not private to `userSid`, or null when it is.
 *
 * A FILE: entries that only pass to children (inherit-only) are not about it.
 * A FOLDER a secret is written into (`container`): they ARE, since a file made
 * there would carry them, and any other grant would let a stranger list it or
 * open what is made in it before its own list is set.
 */
export function privacyProblem(descriptor: Descriptor, userSid: string, options: { container?: boolean } = {}): string | null {
  const trusted = new Set([userSid.toUpperCase(), SYSTEM_SID, ADMINISTRATORS_SID])
  if (!trusted.has(descriptor.owner.toUpperCase())) return `it is owned by ${descriptor.owner}, who may rewrite its access list`
  if (descriptor.dacl.kind === 'absent') return 'it has no access list, so everyone may open it'
  if (descriptor.dacl.kind === 'null') return 'it has a NULL access list, so everyone may open it'
  for (const ace of descriptor.dacl.aces) {
    if (ace.type === 'deny') continue
    if (ace.inheritOnly && !options.container) continue
    const who = ace.sid.toUpperCase()
    if (trusted.has(who) || (options.container && ace.inheritOnly && who === CREATOR_OWNER_SID)) continue
    return `it lets ${ace.sid} in`
  }
  return null
}

/** What PowerShell reports for one file or folder: this process's SID and its descriptor. */
export interface WindowsSecurity {
  readonly userSid: string
  readonly descriptor: Buffer
}

/** Off the main thread's clock: async, and bounded so a hung PowerShell is a refusal, not a wait. */
export const POWERSHELL_TIMEOUT_MS = 10_000

const powershell = (): string =>
  path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/*
 * CONSTANT SCRIPTS. Nothing in them varies: the path reaches PowerShell as
 * $env:COOKREW_ACL_PATH and a secret as stdin, never as script text, so no
 * name or path is ever parsed as PowerShell. They hold no double quote, so the
 * Windows command line passes each one through -Command unchanged. The binary
 * descriptor is read through .NET (GetAccessControl), not Get-Acl, so no
 * module has to load.
 */
const ME = '$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'
const PRINT = '[Console]::Out.WriteLine($me); [Console]::Out.WriteLine([Convert]::ToBase64String($sd.GetSecurityDescriptorBinaryForm()))'
const STOP = "$ErrorActionPreference = 'Stop'"

/** This user's SID, then the file's binary descriptor. */
export const READ_FILE_SCRIPT = [STOP, ME, '$sd = [System.IO.File]::GetAccessControl($env:COOKREW_ACL_PATH)', PRINT].join('; ')

/** This user's SID, then the folder's binary descriptor. */
export const READ_FOLDER_SCRIPT = [STOP, ME, '$sd = [System.IO.Directory]::GetAccessControl($env:COOKREW_ACL_PATH)', PRINT].join('; ')

/**
 * Create the file WITH its list, in one call: FileStream(CreateNew, ...,
 * FileSecurity) hands Windows the descriptor at creation, so there is no moment
 * at which the file exists under its folder's inherited list. The list is
 * exactly this user, SYSTEM and Administrators, protected from inheritance.
 * The secret arrives on stdin (base64) and is written through that same
 * handle; nothing reopens the file by name. Then what Windows kept is printed.
 */
export const CREATE_PRIVATE_SCRIPT = [
  STOP,
  ME,
  '$acl = New-Object System.Security.AccessControl.FileSecurity',
  "$acl.SetSecurityDescriptorSddlForm('D:P(A;;FA;;;' + $me + ')(A;;FA;;;SY)(A;;FA;;;BA)', [System.Security.AccessControl.AccessControlSections]::Access)",
  '$bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())',
  '$fs = New-Object System.IO.FileStream($env:COOKREW_ACL_PATH, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::Write, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::WriteThrough, $acl)',
  'try { $fs.Write($bytes, 0, $bytes.Length); $fs.Flush() } finally { $fs.Dispose() }',
  '$sd = [System.IO.File]::GetAccessControl($env:COOKREW_ACL_PATH)',
  PRINT
].join('; ')

/** The arguments PowerShell is started with: a constant script, nothing else. */
export function powershellArgs(script: string): string[] {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script]
}

/** Parse what a script printed: a SID line, then a base64 descriptor line. */
export function parseReport(out: string): WindowsSecurity {
  const [userSid = '', encoded = ''] = out.trim().split(/\r?\n/).map((line) => line.trim())
  if (!SID_PATTERN.test(userSid)) throw new Error('PowerShell named no SID for this user')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('PowerShell returned no security descriptor')
  return { userSid, descriptor: Buffer.from(encoded, 'base64') }
}

function runPowershell(script: string, target: string, stdin = ''): Promise<WindowsSecurity> {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell(), powershellArgs(script), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, COOKREW_ACL_PATH: target }
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`PowerShell took over ${POWERSHELL_TIMEOUT_MS} ms`))
    }, POWERSHELL_TIMEOUT_MS)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk))
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`PowerShell exited ${code}: ${err.trim().split(/\r?\n/)[0] ?? ''}`))
      else {
        try {
          resolve(parseReport(out))
        } catch (error) {
          reject(error)
        }
      }
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(stdin)
  })
}

/** The file's owner and access list as Windows has them now. Rejects when they cannot be read. */
export function readWindowsSecurity(file: string): Promise<WindowsSecurity> {
  return runPowershell(READ_FILE_SCRIPT, file)
}

/** The folder's owner and access list as Windows has them now. Rejects when they cannot be read. */
export function readWindowsFolderSecurity(dir: string): Promise<WindowsSecurity> {
  return runPowershell(READ_FOLDER_SCRIPT, dir)
}

/** Create `file` private from its first instant, write `data` through that handle, report what Windows kept. */
export function createWindowsPrivateFile(file: string, data: Buffer): Promise<WindowsSecurity> {
  return runPowershell(CREATE_PRIVATE_SCRIPT, file, data.toString('base64'))
}
