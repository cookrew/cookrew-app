import { describe, expect, it } from 'vitest'
import {
  buildAttachmentPaste,
  sanitizeAttachmentName,
  shellQuotePath
} from '../src/shared/attach'

describe('shellQuotePath', () => {
  it('leaves plain paths untouched', () => {
    expect(shellQuotePath('/Users/me/notes.txt')).toBe('/Users/me/notes.txt')
    expect(shellQuotePath('./a-b_c.1+2:3@4,5/file')).toBe('./a-b_c.1+2:3@4,5/file')
  })

  it('backslash-escapes spaces and shell metacharacters', () => {
    expect(shellQuotePath('/tmp/My File.png')).toBe('/tmp/My\\ File.png')
    expect(shellQuotePath("/tmp/it's here")).toBe("/tmp/it\\'s\\ here")
    expect(shellQuotePath('/tmp/a$(b)&c;d')).toBe('/tmp/a\\$\\(b\\)\\&c\\;d')
    expect(shellQuotePath('/tmp/back\\slash')).toBe('/tmp/back\\\\slash')
  })

  it('drops control characters instead of escaping them', () => {
    expect(shellQuotePath('/tmp/a\x1b[31mred')).toBe('/tmp/a\\[31mred')
    expect(shellQuotePath('/tmp/line\nbreak\rname')).toBe('/tmp/linebreakname')
    expect(shellQuotePath('/tmp/del\x7fchar')).toBe('/tmp/delchar')
  })
})

describe('buildAttachmentPaste', () => {
  it('wraps quoted paths in a single bracketed paste with a trailing space', () => {
    expect(buildAttachmentPaste(['/tmp/a.txt'])).toBe('\x1b[200~/tmp/a.txt \x1b[201~')
  })

  it('joins multiple paths with spaces', () => {
    expect(buildAttachmentPaste(['/tmp/a.txt', '/tmp/b c.png'])).toBe(
      '\x1b[200~/tmp/a.txt /tmp/b\\ c.png \x1b[201~'
    )
  })

  it('returns an empty string for no paths', () => {
    expect(buildAttachmentPaste([])).toBe('')
  })
})

describe('sanitizeAttachmentName', () => {
  it('keeps safe names as-is', () => {
    expect(sanitizeAttachmentName('report_v2.final.pdf')).toBe('report_v2.final.pdf')
  })

  it('replaces whitespace and unsafe characters with dashes', () => {
    expect(sanitizeAttachmentName('My Photo (1).png')).toBe('My-Photo-1.png')
    expect(sanitizeAttachmentName('a//b\\c.txt')).toBe('a-b-c.txt')
  })

  it('strips path traversal and leading dots', () => {
    expect(sanitizeAttachmentName('../../etc/passwd')).toBe('etc-passwd')
    expect(sanitizeAttachmentName('...hidden')).toBe('hidden')
  })

  it('falls back to "file" when nothing survives', () => {
    expect(sanitizeAttachmentName('')).toBe('file')
    expect(sanitizeAttachmentName('///')).toBe('file')
  })

  it('caps very long names while keeping the extension', () => {
    const name = sanitizeAttachmentName(`${'x'.repeat(200)}.png`)
    expect(name.length).toBeLessThanOrEqual(80)
    expect(name.endsWith('.png')).toBe(true)
  })
})
