import { afterEach, describe, expect, it, vi } from 'vitest'
import { askTerminal, decodeRawEscapes, diffOutput } from '../src/main/ask'
import type { PtySession } from '../src/main/pty'

describe('askTerminal', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes the prompt and the submitting Enter separately, with a delay', async () => {
    vi.useFakeTimers()
    const writes: { data: string; at: number }[] = []
    const session = {
      fullText: () => '',
      idleFor: () => 99_999,
      write: (data: string) => {
        writes.push({ data, at: Date.now() })
      }
    } as unknown as PtySession

    const promise = askTerminal(session, 'fix the bug', { quiescenceMs: 0, graceMs: 0 })
    // The prompt must land alone first — the Enter goes in a later write so
    // the agent TUI cannot fold it into a paste.
    expect(writes.map((w) => w.data)).toEqual(['fix the bug'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes.map((w) => w.data)).toEqual(['fix the bug', '\r'])
    expect(writes[1].at - writes[0].at).toBeGreaterThan(0)
    await promise
  })
})

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
