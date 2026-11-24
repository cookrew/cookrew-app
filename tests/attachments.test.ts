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

describe('an attachment going up, by route', () => {
  it('is a POST to /api/attachments at the root or under a workspace slug, the query aside', async () => {
    const { isAttachUpload } = await import('../src/main/attachments')
    expect(isAttachUpload('POST', '/api/attachments')).toBe(true)
    expect(isAttachUpload('post', '/api/attachments?name=clip.mp4')).toBe(true)
    expect(isAttachUpload('POST', '/my-work/api/attachments?name=a.png')).toBe(true)
    expect(isAttachUpload('GET', '/api/attachments')).toBe(false)
    expect(isAttachUpload('POST', '/api/attachmentsx')).toBe(false)
    expect(isAttachUpload('POST', '/api/attachments/x')).toBe(false)
    // A first segment the router does not read as a slug is no route of the Mac's.
    expect(isAttachUpload('POST', '/Not_A_Slug/api/attachments')).toBe(false)
    expect(isAttachUpload('POST', '/assets/api/attachments')).toBe(false)
    expect(isAttachUpload('POST', '/a/b/api/attachments')).toBe(false)
  })

  it('sealed, takes a little more than the phone sends there, never the whole save cap', async () => {
    const { SEALED_ATTACH_MAX, SEALED_ATTACH_BUDGET, MAX_ATTACHMENT_BYTES } = await import('../src/main/attachments')
    const { SEALED_RELAY_BODY_MAX } = await import('../src/shared/attachment-limit')
    expect(SEALED_ATTACH_MAX).toBeGreaterThanOrEqual(SEALED_RELAY_BODY_MAX)
    expect(SEALED_ATTACH_MAX).toBeLessThan(MAX_ATTACHMENT_BYTES)
    expect(SEALED_ATTACH_BUDGET).toBe(2 * SEALED_ATTACH_MAX)
  })
})

describe('a sealed session\'s attachment budget', () => {
  it('takes what fits, refuses what would pass it without counting it, and takes again once given back', async () => {
    const { sealBudget } = await import('../src/main/seal2-serve-http')
    const budget = sealBudget(10)
    expect(budget.take(6)).toBe(true)
    expect(budget.take(5)).toBe(false)
    expect(budget.take(4)).toBe(true)
    budget.give(6)
    expect(budget.take(6)).toBe(true)
  })

  it('counts an attachment only; every other route keeps the small cap and the two-minute wait', async () => {
    const { sealBodyLimits } = await import('../src/main/seal2-serve-http')
    expect(sealBodyLimits('POST', '/api/attachments?name=a.mp4')).toEqual({ max: 32 * 1024 * 1024, ms: 600_000, budgeted: true })
    expect(sealBodyLimits('POST', '/api/terminal/t1/input')).toEqual({ max: 4 * 1024 * 1024, ms: 120_000, budgeted: false })
  })
})
