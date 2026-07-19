import { describe, expect, it } from 'vitest'
import { decodeRawEscapes, diffOutput } from '../src/main/ask'

describe('diffOutput', () => {
  it('returns appended text when after extends before', () => {
    expect(diffOutput('$ ls', '$ ls\nfile.txt\n$')).toBe('file.txt\n$')
  })

  it('returns same-line continuation when the prompt line is extended', () => {
    const before = 'line1\nprompt>'
    const after = 'line1\nprompt> echo hi\nhi\nprompt>'
    expect(diffOutput(before, after)).toBe(' echo hi\nhi\nprompt>')
  })

  it('falls back to common-prefix when earlier lines were redrawn', () => {
    const before = 'line1\nspinner...'
    const after = 'line1\ndone\nresult'
    expect(diffOutput(before, after)).toBe('done\nresult')
  })

  it('returns empty string when nothing changed', () => {
    expect(diffOutput('same', 'same')).toBe('')
  })
})

describe('decodeRawEscapes', () => {
  it('maps \\n to carriage return (Enter)', () => {
    expect(decodeRawEscapes('2\\n')).toBe('2\r')
  })

  it('decodes hex bytes', () => {
    expect(decodeRawEscapes('\\x03')).toBe('\x03')
  })

  it('decodes ESC sequences', () => {
    expect(decodeRawEscapes('\\e[A')).toBe('\x1b[A')
  })
})
