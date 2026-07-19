import { afterEach, describe, expect, it, vi } from 'vitest'
import { askRaw, askTerminal, decodeRawEscapes, diffOutput, submitDelayMs } from '../src/main/ask'
import type { PtySession } from '../src/main/pty'

describe('submitDelayMs', () => {
  it('starts at the base delay for short prompts', () => {
    expect(submitDelayMs(0)).toBe(150)
    expect(submitDelayMs(20)).toBeLessThan(200)
  })

  it('scales up with prompt size', () => {
    expect(submitDelayMs(10 * 1024)).toBe(1150)
  })

  it('caps at 1.5s for huge prompts', () => {
    expect(submitDelayMs(1_000_000)).toBe(1500)
  })
})

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

  it('holds the Enter longer for long prompts still being ingested', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const session = {
      fullText: () => '',
      idleFor: () => 99_999,
      write: (data: string) => {
        writes.push(data)
      }
    } as unknown as PtySession
    const prompt = 'x'.repeat(10 * 1024)

    const promise = askTerminal(session, prompt, { quiescenceMs: 0, graceMs: 0 })
    // The base delay alone is not enough for a 10KB paste — the Enter must
    // not have been sent yet.
    await vi.advanceTimersByTimeAsync(500)
    expect(writes).toEqual([prompt])
    await vi.advanceTimersByTimeAsync(1200)
    expect(writes).toEqual([prompt, '\r'])
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

describe('askRaw', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const fakeSession = (writes: { data: string; at: number }[]): PtySession =>
    ({
      viewportText: () => '',
      write: (data: string) => {
        writes.push({ data, at: Date.now() })
      }
    }) as unknown as PtySession

  it('splits a trailing Enter off a text payload so the TUI cannot fold it into the paste', async () => {
    vi.useFakeTimers()
    const writes: { data: string; at: number }[] = []
    const promise = askRaw(fakeSession(writes), 'OPS RULE: do not run npm run dev\r')
    expect(writes.map((w) => w.data)).toEqual(['OPS RULE: do not run npm run dev'])
    await vi.advanceTimersByTimeAsync(2500)
    await promise
    expect(writes.map((w) => w.data)).toEqual(['OPS RULE: do not run npm run dev', '\r'])
    expect(writes[1].at - writes[0].at).toBeGreaterThanOrEqual(submitDelayMs(32))
  })

  it('passes a bare Enter through unchanged', async () => {
    vi.useFakeTimers()
    const writes: { data: string; at: number }[] = []
    const promise = askRaw(fakeSession(writes), '\r')
    expect(writes.map((w) => w.data)).toEqual(['\r'])
    await vi.advanceTimersByTimeAsync(1000)
    await promise
  })

  it('passes control sequences through unchanged', async () => {
    vi.useFakeTimers()
    const writes: { data: string; at: number }[] = []
    const promise = askRaw(fakeSession(writes), '\x1b[A')
    expect(writes.map((w) => w.data)).toEqual(['\x1b[A'])
    await vi.advanceTimersByTimeAsync(1000)
    await promise
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
