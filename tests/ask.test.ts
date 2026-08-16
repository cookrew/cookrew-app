import { afterEach, describe, expect, it, vi } from 'vitest'
import { askRaw, askTerminal, decodeRawEscapes, diffOutput, submitDelayMs } from '../src/main/ask'
import type { PtySession } from '../src/main/pty'

/**
 * The ask layer's one runtime dependency on the pty module is multiplexer().
 * Held in a test-controlled slot: null (the default) exercises the typed
 * path exactly as before; a fake with agentLifecycle exercises the
 * herdr-native path and its submit-site guard (Sol r5 P0-1).
 */
interface FakeMux {
  capabilities: { agentLifecycle: boolean }
  promptAgent?: (
    sessionName: string,
    prompt: string,
    timeoutMs: number
  ) => Promise<'done' | 'submitted' | 'failed'>
  waitUntilIdle?: (sessionName: string, timeoutMs: number) => Promise<boolean>
}
const muxHolder = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('../src/main/pty', () => ({
  multiplexer: () => muxHolder.current
}))

/** Wrap text the way the ask layer delivers it: one bracketed-paste unit. */
const paste = (body: string): string => `\x1b[200~${body}\x1b[201~`

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
    // The prompt lands first as one bracketed-paste unit; the Enter goes in a
    // later write so the agent TUI finalizes the paste and cannot fold it in.
    expect(writes.map((w) => w.data)).toEqual([paste('fix the bug')])
    await vi.advanceTimersByTimeAsync(1000)
    expect(writes.map((w) => w.data)).toEqual([paste('fix the bug'), '\r'])
    expect(writes[1].at - writes[0].at).toBeGreaterThan(0)
    await promise
  })

  it('sends a multi-line prompt as ONE bracketed paste, not split on newlines', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const session = {
      fullText: () => '',
      idleFor: () => 99_999,
      write: (data: string) => {
        writes.push(data)
      }
    } as unknown as PtySession
    const prompt = 'line one\nline two\nline three'

    const promise = askTerminal(session, prompt, { quiescenceMs: 0, graceMs: 0 })
    // The whole prompt is a single write bounded by paste markers — no
    // interior \r that a TUI could treat as a premature submit.
    expect(writes).toEqual([paste(prompt)])
    expect(writes[0].startsWith('\x1b[200~')).toBe(true)
    expect(writes[0].endsWith('\x1b[201~')).toBe(true)
    await vi.advanceTimersByTimeAsync(1200)
    expect(writes).toEqual([paste(prompt), '\r'])
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
    expect(writes).toEqual([paste(prompt)])
    await vi.advanceTimersByTimeAsync(1200)
    expect(writes).toEqual([paste(prompt), '\r'])
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
    expect(writes.map((w) => w.data)).toEqual([paste('OPS RULE: do not run npm run dev')])
    await vi.advanceTimersByTimeAsync(2500)
    await promise
    expect(writes.map((w) => w.data)).toEqual([paste('OPS RULE: do not run npm run dev'), '\r'])
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

// ---------------------------------------------------------------------------
// Sol r5 P0-1 — the one-producer guard runs at the SUBMIT site: a native ask
// consults the session's owner-input guard synchronously before the
// irreversible promptAgent call (and the typed path before its paste), so an
// armed dispatch is durably preempted or the ask is refused — a route-level
// armed check upstream is a fast path with a check-to-submit race behind it.
// ---------------------------------------------------------------------------

describe('askTerminal — the one-producer guard at the submit site (Sol r5 P0-1)', () => {
  afterEach(() => {
    muxHolder.current = null
    vi.useRealTimers()
  })

  const nativeMux = (
    events: string[],
    outcome: 'done' | 'submitted' | 'failed' = 'done'
  ): FakeMux => ({
    capabilities: { agentLifecycle: true },
    promptAgent: async () => {
      events.push('promptAgent')
      return outcome
    }
  })

  it('consults the guard with the SUBMITTING bytes, synchronously before promptAgent', async () => {
    const events: string[] = []
    muxHolder.current = nativeMux(events)
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      noteExternalInput: (data: string) => events.push(`announce:${JSON.stringify(data)}`),
      beforeOwnerInput: (terminalId: string, data: string) => {
        events.push(`guard:${terminalId}:${JSON.stringify(data)}`)
        return 'allow' as const
      }
    } as unknown as PtySession

    await askTerminal(session, 'fix the bug')
    // The guard sees prompt + Enter (the bytes that SUBMIT — a bare prompt
    // reads as typing and would not trigger preemption), the verdict precedes
    // the submission with nothing in between, and only an accepted
    // submission is announced as owner work.
    expect(events).toEqual([
      'guard:term-1:"fix the bug\\r"',
      'promptAgent',
      'announce:"fix the bug\\r"'
    ])
  })

  it('REFUSES the ask on preempt-failed: no submission, no announcement', async () => {
    const events: string[] = []
    muxHolder.current = nativeMux(events)
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      noteExternalInput: () => events.push('announce'),
      beforeOwnerInput: () => 'preempt-failed' as const
    } as unknown as PtySession

    await expect(askTerminal(session, 'fix the bug')).rejects.toThrow(
      'agent has a dispatch in flight that could not be preempted'
    )
    expect(events).toEqual([])
  })

  it('closes the check-to-submit race: a dispatch arming AFTER route admission is still caught', async () => {
    // The route's armed check passed with nothing armed; a dispatch arms
    // while the request is still being read (modeled inside fullText, the
    // last read before the guard). The submit-site guard — not the stale
    // route answer — decides, and it refuses.
    let armed = false
    const events: string[] = []
    muxHolder.current = nativeMux(events)
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => {
        armed = true
        return ''
      },
      noteExternalInput: () => events.push('announce'),
      beforeOwnerInput: (): 'allow' | 'preempt-failed' =>
        armed ? 'preempt-failed' : 'allow'
    } as unknown as PtySession

    await expect(askTerminal(session, 'deploy the release')).rejects.toThrow(
      'agent has a dispatch in flight that could not be preempted'
    )
    expect(events).toEqual([])
  })

  it('a guard that PREEMPTS (allow after committing the interrupt) lets the ask proceed', async () => {
    // The armed-dispatch case where preemption CAN commit: the guard
    // interrupts the dispatch durably and answers allow — the ask then owns
    // the agent and submits exactly once.
    const events: string[] = []
    muxHolder.current = nativeMux(events)
    let dispatchOpen = true
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      noteExternalInput: () => events.push('announce'),
      beforeOwnerInput: () => {
        if (dispatchOpen) {
          dispatchOpen = false // the durable preemption
          events.push('preempted')
        }
        return 'allow' as const
      }
    } as unknown as PtySession

    await askTerminal(session, 'fix the bug')
    expect(events).toEqual(['preempted', 'promptAgent', 'announce'])
    expect(dispatchOpen).toBe(false)
  })

  it('guards the TYPED path too: a refused ask throws instead of silently dropping bytes', async () => {
    // No native mux → pasteAndSubmit, whose writes cross session.write. That
    // guard refuses by silently dropping the submit — which here would mean
    // waiting out quiescence over an agent that never got the prompt and
    // returning noise as its reply. The ask-level guard makes the refusal an
    // honest error, before anything reaches the pty.
    muxHolder.current = null
    const writes: string[] = []
    const session = {
      terminalId: 'term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      write: (data: string) => writes.push(data),
      beforeOwnerInput: () => 'preempt-failed' as const
    } as unknown as PtySession

    await expect(askTerminal(session, 'fix the bug')).rejects.toThrow(
      'agent has a dispatch in flight that could not be preempted'
    )
    expect(writes).toEqual([])
  })

  it('an unwired guard allows — plain sessions and existing tests are untouched', async () => {
    const events: string[] = []
    muxHolder.current = nativeMux(events)
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      noteExternalInput: () => events.push('announce')
      // no beforeOwnerInput: nothing wired, nothing armed — allow.
    } as unknown as PtySession

    await askTerminal(session, 'fix the bug')
    expect(events).toEqual(['promptAgent', 'announce'])
  })
})
