import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_ATTACHMENT_BYTES, saveAttachment } from '../src/main/attachments'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cookrew-attach-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('saveAttachment', () => {
  it('writes the bytes and returns an absolute path inside the dir', () => {
    const saved = saveAttachment(dir, 'photo.png', Buffer.from('abc'))
    expect(saved.startsWith(dir + path.sep)).toBe(true)
    expect(readFileSync(saved, 'utf8')).toBe('abc')
  })

  it('sanitizes hostile names into the attachments dir', () => {
    const saved = saveAttachment(dir, '../../evil.sh', Buffer.from('x'))
    expect(saved.startsWith(dir + path.sep)).toBe(true)
    expect(path.basename(saved)).toBe('evil.sh')
  })

  it('never overwrites an existing attachment', () => {
    const first = saveAttachment(dir, 'a.txt', Buffer.from('one'))
    const second = saveAttachment(dir, 'a.txt', Buffer.from('two'))
    expect(second).not.toBe(first)
    expect(readFileSync(first, 'utf8')).toBe('one')
    expect(readFileSync(second, 'utf8')).toBe('two')
  })

  it('creates the directory when missing', () => {
    const nested = path.join(dir, 'not', 'yet', 'there')
    const saved = saveAttachment(nested, 'f.bin', Buffer.from('ok'))
    expect(readFileSync(saved, 'utf8')).toBe('ok')
  })

  it('rejects oversized payloads', () => {
    const big = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1)
    expect(() => saveAttachment(dir, 'big.bin', big)).toThrow(/too large/i)
  })
})
