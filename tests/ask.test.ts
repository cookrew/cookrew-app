import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  askRaw,
  askTerminal,
  decodeRawEscapes,
  diffOutput,
  pasteAndSubmit,
  submitDelayMs
} from '../src/main/ask'
import { ProducerLease, ownerHolder } from '../src/main/producer-lease'
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
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<'done' | 'submitted' | 'failed'>
  submitAgent?: (
    sessionName: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<'submitted' | 'failed'>
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

// ---------------------------------------------------------------------------
// Sol r6 P0-1 / P0-2 — the ask under the producer lease. The r5 guard was a
// point-in-time verdict; the lease is the reservation behind it: held through
// promptAgent resolve (native) or paste+CR completion (typed), refusing a
// concurrent owner submission honestly, and threading its own validity into
// the delayed CR so a lost hold never submits.
// ---------------------------------------------------------------------------

describe('pasteAndSubmit — cancellation awareness (Sol r6 P0-2)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  const fakeSession = (writes: string[]): PtySession =>
    ({
      write: (data: string) => writes.push(data)
    }) as unknown as PtySession

  it('a stillValid that goes false during the delay stops the CR (no submit)', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    let valid = true
    const promise = pasteAndSubmit(fakeSession(writes), 'the brief', undefined, () => valid)
    // The paste went out while the delivery was still live…
    expect(writes).toEqual([paste('the brief')])
    // …then the dispatch is cancelled inside the delay window.
    valid = false
    await vi.advanceTimersByTimeAsync(2000)
    // No CR: the pasted prompt stays UNSUBMITTED (inert residue in the input
    // box — documented on pasteAndSubmit), and the caller learns it stopped.
    expect(writes).toEqual([paste('the brief')])
    await expect(promise).resolves.toBe('cancelled')
  })

  it('a stillValid false before ANY write sends nothing at all', async () => {
    const writes: string[] = []
    await expect(
      pasteAndSubmit(fakeSession(writes), 'the brief', undefined, () => false)
    ).resolves.toBe('cancelled')
    expect(writes).toEqual([])
  })

  it('a hold that stays valid submits exactly as before', async () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const promise = pasteAndSubmit(fakeSession(writes), 'the brief', undefined, () => true)
    await vi.advanceTimersByTimeAsync(2000)
    await expect(promise).resolves.toBe('submitted')
    expect(writes).toEqual([paste('the brief'), '\r'])
  })
})

describe('askTerminal — the producer lease (Sol r6 P0-1)', () => {
  afterEach(() => {
    muxHolder.current = null
    vi.useRealTimers()
  })

  it('the native ask HOLDS the lease across promptAgent and releases on resolve', async () => {
    const lease = new ProducerLease()
    const during: Array<ReturnType<ProducerLease['holderOf']>> = []
    muxHolder.current = {
      capabilities: { agentLifecycle: true },
      promptAgent: async () => {
        during.push(lease.holderOf('term-1'))
        return 'done'
      }
    } satisfies FakeMux
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      noteExternalInput: () => undefined
    } as unknown as PtySession

    await askTerminal(session, 'fix the bug', { lease })
    expect(during).toHaveLength(1)
    expect(during[0]?.kind).toBe('owner')
    expect(lease.holderOf('term-1')).toBeNull()
  })

  it('a second concurrent owner ask is refused honestly — and the first is undisturbed', async () => {
    const lease = new ProducerLease()
    let releaseFirst = (): void => undefined
    const gate = new Promise<'done'>((resolve) => {
      releaseFirst = () => resolve('done')
    })
    let prompts = 0
    muxHolder.current = {
      capabilities: { agentLifecycle: true },
      promptAgent: async () => {
        prompts += 1
        return gate
      }
    } satisfies FakeMux
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      noteExternalInput: () => undefined
    } as unknown as PtySession

    const first = askTerminal(session, 'first ask', { lease })
    // Let the first ask reach its blocking promptAgent.
    await new Promise((resolve) => setImmediate(resolve))
    await expect(askTerminal(session, 'second ask', { lease })).rejects.toThrow(
      'another owner submission is in flight'
    )
    // The refusal submitted nothing and did not disturb the first ask's hold.
    expect(prompts).toBe(1)
    expect(lease.holderOf('term-1')?.kind).toBe('owner')
    releaseFirst()
    await first
    expect(lease.holderOf('term-1')).toBeNull()
  })

  it('held-by-dispatch: the ask is REFUSED — no takeover past the boundary (Sol r7 P0-1)', async () => {
    // The r6 flow preempted the dispatch and SEIZED the window here. But an
    // owner can only observe a dispatch-held lease when promptAgent has
    // already been invoked (no await sits between acquire and submit), so
    // the takeover always landed owner bytes beside a submission the ledger
    // interrupt never actually undid. Conservative rule: refuse and retry.
    const lease = new ProducerLease()
    const dispatch = { kind: 'dispatch', dispatchId: 'dsp-1' } as const
    lease.acquire('term-1', dispatch)
    const events: string[] = []
    muxHolder.current = {
      capabilities: { agentLifecycle: true },
      promptAgent: async () => {
        events.push('promptAgent')
        return 'done'
      }
    } satisfies FakeMux
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      noteExternalInput: () => undefined,
      beforeOwnerInput: () => {
        events.push('preempted')
        return 'allow' as const
      }
    } as unknown as PtySession

    await expect(askTerminal(session, 'take over', { lease })).rejects.toThrow(
      'a dispatch is being delivered — retry in a moment'
    )
    // Nothing was preempted, nothing submitted; the dispatch keeps its
    // window until its own release.
    expect(events).toEqual([])
    expect(lease.holderOf('term-1')).toEqual(dispatch)
    lease.release('term-1', dispatch)
    // Once the delivery settles, the same ask goes through.
    await askTerminal(session, 'take over', { lease })
    expect(events).toEqual(['preempted', 'promptAgent'])
    expect(lease.holderOf('term-1')).toBeNull()
  })

  it('a contaminated input box refuses the ask until the terminal restarts (r8 P0-2)', async () => {
    const lease = new ProducerLease()
    lease.markContaminated('term-1')
    muxHolder.current = {
      capabilities: { agentLifecycle: true },
      promptAgent: async () => 'done'
    } satisfies FakeMux
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      noteExternalInput: () => undefined
    } as unknown as PtySession

    // The refusal names the one real remedy — no control byte clears it.
    await expect(askTerminal(session, 'fresh work', { lease })).rejects.toThrow(
      'restart the terminal'
    )
    // Only the generation reset (terminal restart) readmits submits.
    lease.retire('term-1')
    await expect(askTerminal(session, 'fresh work', { lease })).resolves.toBe('')
  })

  it('the TYPED path holds the lease across paste → delay → CR', async () => {
    vi.useFakeTimers()
    muxHolder.current = null
    const lease = new ProducerLease()
    const writes: string[] = []
    const session = {
      terminalId: 'term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      write: (data: string) => {
        writes.push(`${data === '\r' ? 'CR' : 'paste'} holder=${lease.holderOf('term-1')?.kind}`)
      }
    } as unknown as PtySession

    const promise = askTerminal(session, 'typed ask', { lease, quiescenceMs: 0, graceMs: 0 })
    await vi.advanceTimersByTimeAsync(2000)
    await promise
    // Both writes happened under the owner hold; released after the CR.
    expect(writes).toEqual(['paste holder=owner', 'CR holder=owner'])
    expect(lease.holderOf('term-1')).toBeNull()
  })

  it('a refusal on the typed path releases the hold before throwing', async () => {
    muxHolder.current = null
    const lease = new ProducerLease()
    const session = {
      terminalId: 'term-1',
      fullText: () => '',
      write: () => undefined,
      beforeOwnerInput: () => 'preempt-failed' as const
    } as unknown as PtySession

    await expect(askTerminal(session, 'typed ask', { lease })).rejects.toThrow(
      'agent has a dispatch in flight that could not be preempted'
    )
    // release-on-cancel: the failed acquisition left no orphan hold.
    expect(lease.holderOf('term-1')).toBeNull()
  })

  it('an owner ask holding via one shared lease refuses a dispatch-held guard verdict too', async () => {
    // The guard's mid-delivery 'refused' verdict is terminal for an ask: a
    // delivery's bytes are in the buffer right now.
    muxHolder.current = {
      capabilities: { agentLifecycle: true },
      promptAgent: async () => 'done'
    } satisfies FakeMux
    const lease = new ProducerLease()
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      noteExternalInput: () => undefined,
      beforeOwnerInput: () => 'refused' as const
    } as unknown as PtySession

    await expect(askTerminal(session, 'fix the bug', { lease })).rejects.toThrow(
      'a dispatch delivery is mid-submission at this terminal'
    )
    expect(lease.holderOf('term-1')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Sol r8 P1 — the native leg's abort seam and the lease-window split.
// ---------------------------------------------------------------------------

describe('askTerminal — abort on terminal retirement (Sol r8 P1)', () => {
  afterEach(() => {
    muxHolder.current = null
  })

  it('retiring the terminal mid-native-wait aborts the child and the ask throws honestly', async () => {
    const lease = new ProducerLease()
    let observed: AbortSignal | undefined
    const writes: string[] = []
    muxHolder.current = {
      capabilities: { agentLifecycle: true },
      // Model execFile with a signal: pending until the abort fires, then
      // reject the way a TERM-killed child settles its callback.
      promptAgent: (_name, _prompt, _timeout, signal) =>
        new Promise((_resolve, reject) => {
          observed = signal
          signal?.addEventListener('abort', () => reject(new Error('AbortError')), {
            once: true
          })
        })
    } satisfies FakeMux
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      write: (data: string) => writes.push(data),
      noteExternalInput: () => undefined
    } as unknown as PtySession

    const promise = askTerminal(session, 'doomed ask', { lease })
    // Let the ask reach its blocking native call, then end the terminal.
    await new Promise((resolve) => setImmediate(resolve))
    expect(observed?.aborted).toBe(false)
    lease.retire('term-1')
    expect(observed?.aborted).toBe(true)
    // The promise settles NOW (not at the ask timeout), throws instead of
    // falling through to type into the reborn terminal, and left no state:
    // no typed-path writes, no hold, and the dead leg's release no-oped.
    await expect(promise).rejects.toThrow('retired mid-ask')
    expect(writes).toEqual([])
    expect(lease.holderOf('term-1')).toBeNull()
  })
})

describe('askTerminal — the submission-ack lease window (Sol r8 P1)', () => {
  afterEach(() => {
    muxHolder.current = null
  })

  it('with submitAgent, the lease covers only the ack; the reply-wait runs outside it', async () => {
    const lease = new ProducerLease()
    const holderDuring: Array<string | undefined> = []
    muxHolder.current = {
      capabilities: { agentLifecycle: true },
      submitAgent: async () => {
        holderDuring.push(lease.holderOf('term-1')?.kind)
        return 'submitted'
      },
      waitUntilIdle: async () => {
        holderDuring.push(lease.holderOf('term-1')?.kind)
        return true
      }
    } satisfies FakeMux
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      noteExternalInput: () => undefined
    } as unknown as PtySession

    await askTerminal(session, 'quick ask', { lease, quiescenceMs: 0, graceMs: 0 })
    // Held for the submission acknowledgement, FREE for the minutes-long
    // reply wait — the desktop's input box is refused for milliseconds, not
    // the whole turn.
    expect(holderDuring).toEqual(['owner', undefined])
    expect(lease.holderOf('term-1')).toBeNull()
  })

  it('a positively failed submitAgent falls back to the typed path, exactly like promptAgent', async () => {
    vi.useFakeTimers()
    const lease = new ProducerLease()
    const writes: string[] = []
    muxHolder.current = {
      capabilities: { agentLifecycle: true },
      submitAgent: async () => 'failed'
    } satisfies FakeMux
    const session = {
      terminalId: 'term-1',
      sessionName: 'cookrew_term-1',
      fullText: () => '',
      idleFor: () => 99_999,
      write: (data: string) => writes.push(data),
      noteExternalInput: () => undefined
    } as unknown as PtySession

    const promise = askTerminal(session, 'typed instead', {
      lease,
      quiescenceMs: 0,
      graceMs: 0
    })
    await vi.advanceTimersByTimeAsync(3000)
    await promise
    expect(writes).toEqual([paste('typed instead'), '\r'])
  })
})
