/**
 * Self-relative Windows security descriptors, built byte by byte as
 * GetSecurityDescriptorBinaryForm returns them, so the parser and the privacy
 * rules (src/main/windows-acl.ts) are exercised on every OS. Layout: MS-DTYP
 * 2.4.6 (SECURITY_DESCRIPTOR_RELATIVE), 2.4.5 (ACL), 2.4.4.2 (ACCESS_*_ACE),
 * 2.4.2.2 (SID).
 */

export const ACE_ALLOWED = 0
export const ACE_DENIED = 1
export const INHERIT_ONLY = 0x08
export const FULL = 0x001f01ff

const SE_DACL_PRESENT = 0x0004
const SE_DACL_PROTECTED = 0x1000
const SE_SELF_RELATIVE = 0x8000

export function sid(text: string): Buffer {
  const [, revision, authority, ...subs] = text.split('-')
  const out = Buffer.alloc(8 + 4 * subs.length)
  out.writeUInt8(Number(revision), 0)
  out.writeUInt8(subs.length, 1)
  out.writeUIntBE(Number(authority), 2, 6)
  subs.forEach((sub, at) => out.writeUInt32LE(Number(sub) >>> 0, 8 + 4 * at))
  return out
}

export function ace(type: number, who: string, { flags = 0, mask = FULL } = {}): Buffer {
  const body = sid(who)
  const out = Buffer.alloc(8 + body.length)
  out.writeUInt8(type, 0)
  out.writeUInt8(flags, 1)
  out.writeUInt16LE(out.length, 2)
  out.writeUInt32LE(mask, 4)
  body.copy(out, 8)
  return out
}

export function acl(aces: readonly Buffer[], { revision = 2, slack = 0 } = {}): Buffer {
  const size = 8 + aces.reduce((sum, a) => sum + a.length, 0) + slack
  const head = Buffer.alloc(8)
  head.writeUInt8(revision, 0)
  head.writeUInt16LE(size, 2)
  head.writeUInt16LE(aces.length, 4)
  return Buffer.concat([head, ...aces, Buffer.alloc(slack)])
}

export interface DescriptorParts {
  owner?: string | null
  group?: string | null
  /** null: DACL_PRESENT with offset 0, the NULL DACL that lets everyone in. undefined: no DACL at all. */
  dacl?: Buffer | null
  protectedDacl?: boolean
  /** Extra bytes after the last section: a descriptor that is not fully accounted for. */
  tail?: Buffer
  control?: number
}

export function descriptor(parts: DescriptorParts): Buffer {
  const sections: Buffer[] = []
  let at = 20
  const place = (bytes: Buffer | null | undefined): number => {
    if (!bytes) return 0
    const offset = at
    sections.push(bytes)
    at += bytes.length
    return offset
  }
  const daclOffset = place(parts.dacl ?? null)
  const ownerOffset = place(parts.owner ? sid(parts.owner) : null)
  const groupOffset = place(parts.group ? sid(parts.group) : null)
  let control = SE_SELF_RELATIVE
  if (parts.dacl !== undefined) control |= SE_DACL_PRESENT
  if (parts.protectedDacl) control |= SE_DACL_PROTECTED
  const head = Buffer.alloc(20)
  head.writeUInt8(1, 0)
  head.writeUInt16LE(parts.control ?? control, 2)
  head.writeUInt32LE(ownerOffset, 4)
  head.writeUInt32LE(groupOffset, 8)
  head.writeUInt32LE(0, 12)
  head.writeUInt32LE(daclOffset, 16)
  return Buffer.concat([head, ...sections, parts.tail ?? Buffer.alloc(0)])
}
