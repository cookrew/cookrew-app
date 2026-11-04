import { describe, expect, it } from 'vitest'
import { createRawInputQueue } from '../src/renderer/src/raw-input-queue'

/**
 * Keystrokes from the phone used to leave as one POST each, unserialized.
 * Two costs: parallel fetches can arrive REORDERED ('ab' lands as 'ba' —
 * ordering the desktop's IPC gives for free), and a burst of N keys paid
 * N sets of headers and N round trips on a link where round trips are the
 * scarce thing. The queue holds ONE request in flight per terminal; bytes
 * typed meanwhile ride the next request as a single batch. No timer — an
 * isolated keystroke still leaves immediately.
 */

function harness(): {
  push: (terminalId: string, data: string) => void
  sent: Array<{ terminalId: string; data: string }>
  settle: (index: number, outcome?: 'ok' | 'fail') => void
  inFlight: () => number
} {
  const sent: Array<{ terminalId: string; data: string }> = []
  const settlers: Array<{ resolve: () => void; reject: () => void }> = []
  const push = createRawInputQueue(
    (terminalId, data) =>
      new Promise<void>((resolve, reject) => {
        sent.push({ terminalId, data })
        settlers.push({ resolve, reject: () => reject(new Error('send failed')) })
      })
  )
  return {
    push,
    sent,
    settle: (index, outcome = 'ok') =>
      outcome === 'ok' ? settlers[index].resolve() : settlers[index].reject(),
    inFlight: () => sent.length
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the ordered keystroke queue', () => {
  it('an isolated keystroke leaves immediately, no timer', () => {
    const h = harness()
    h.push('t1', 'a')
    expect(h.sent).toEqual([{ terminalId: 't1', data: 'a' }])
  })

  it('bytes typed during the flight ride the next request as ONE batch, in order', async () => {
    const h = harness()
    h.push('t1', 'a')
    h.push('t1', 'b')
    h.push('t1', 'c')
    expect(h.sent).toHaveLength(1)
    h.settle(0)
    await tick()
    expect(h.sent).toEqual([
      { terminalId: 't1', data: 'a' },
      { terminalId: 't1', data: 'bc' }
    ])
  })

  it('a failed request does not wedge the queue or drop the bytes behind it', async () => {
    const h = harness()
    h.push('t1', 'a')
    h.push('t1', 'b')
    h.settle(0, 'fail')
    await tick()
    expect(h.sent).toEqual([
      { terminalId: 't1', data: 'a' },
      { terminalId: 't1', data: 'b' }
    ])
  })

  it('terminals do not share a lane — one card in flight never delays another', () => {
    const h = harness()
    h.push('t1', 'a')
    h.push('t2', 'x')
    expect(h.sent).toEqual([
      { terminalId: 't1', data: 'a' },
      { terminalId: 't2', data: 'x' }
    ])
  })

  it('a chunk carrying Enter travels alone — batching must not invent a paste', async () => {
    // ownerSubmit reads each request body whole: 'b\r' merged would take the
    // bracketed-paste path the discrete keys never took. The CR keeps its own
    // request, and nothing merges ACROSS it either.
    const h = harness()
    h.push('t1', 'a')
    h.push('t1', 'b')
    h.push('t1', '\r')
    h.push('t1', 'c')
    h.settle(0)
    await tick()
    expect(h.sent[1]).toEqual({ terminalId: 't1', data: 'b' })
    h.settle(1)
    await tick()
    expect(h.sent[2]).toEqual({ terminalId: 't1', data: '\r' })
    h.settle(2)
    await tick()
    expect(h.sent[3]).toEqual({ terminalId: 't1', data: 'c' })
  })

  it('a pasted block keeps its one-request shape — the paste-swallow guard relies on it', () => {
    const h = harness()
    h.push('t1', 'hello world\r')
    expect(h.sent).toEqual([{ terminalId: 't1', data: 'hello world\r' }])
  })
})

describe('a keystroke request that never answers', () => {
  it('is aborted at the deadline and sent again, and the typing behind it still goes — 2026-10-18, Tailscale dropped mid-request', async () => {
    const sent: string[] = []
    const signals: AbortSignal[] = []
    const push = createRawInputQueue((_id, data, signal) => {
      sent.push(data)
      signals.push(signal)
      // The first never settles, as a fetch on a dead path does not.
      return sent.length === 1 ? new Promise(() => undefined) : Promise.resolve()
    }, { deadlineMs: 20 })
    push('t1', 'a')
    push('t1', 'b')
    push('t1', 'c')
    expect(sent).toEqual(['a'])
    await new Promise((r) => setTimeout(r, 40))
    expect(signals[0].aborted).toBe(true)
    expect((signals[0].reason as Error).name).toBe('TimeoutError')
    // No answer is not "not typed": the same batch goes again, and the Mac
    // types its id once (main/once-by-key.ts).
    expect(sent).toEqual(['a', 'a', 'bc'])
  })

  it('leaves an answered request alone', async () => {
    const signals: AbortSignal[] = []
    const push = createRawInputQueue((_id, _data, signal) => {
      signals.push(signal)
      return Promise.resolve()
    }, { deadlineMs: 20 })
    push('t1', 'a')
    await new Promise((r) => setTimeout(r, 40))
    expect(signals[0].aborted).toBe(false)
  })
})

describe('a keystroke batch that got no answer', () => {
  const lost = (): Error => new TypeError('Load failed')

  it('is sent again with the SAME id until it is answered — the letters typed as the plane moved', async () => {
    const calls: Array<{ data: string; id: string }> = []
    const push = createRawInputQueue(
      (_t, data, _s, id) => {
        calls.push({ data, id })
        return calls.length < 3 ? Promise.reject(lost()) : Promise.resolve()
      },
      { retryable: () => true, nonce: 'n' }
    )
    push('t1', 'x')
    await new Promise((r) => setTimeout(r, 400))
    expect(calls.map((c) => c.data)).toEqual(['x', 'x', 'x'])
    expect(new Set(calls.map((c) => c.id))).toEqual(new Set(['n.1']))
    push('t1', 'y')
    await new Promise((r) => setTimeout(r, 10))
    expect(calls.at(-1)).toEqual({ data: 'y', id: 'n.2' })
  })

  it('is never sent again once the Mac answered, whatever it said', async () => {
    const calls: string[] = []
    const push = createRawInputQueue(
      (_t, data) => {
        calls.push(data)
        return Promise.reject(new Error('409'))
      },
      { retryable: () => false }
    )
    push('t1', 'a')
    await new Promise((r) => setTimeout(r, 300))
    push('t1', 'b')
    await new Promise((r) => setTimeout(r, 10))
    expect(calls).toEqual(['a', 'b'])
  })

  it('is given up after giveUpMs, and the typing behind it goes', async () => {
    let clock = 0
    const calls: string[] = []
    const push = createRawInputQueue(
      (_t, data) => {
        calls.push(data)
        clock += 1_000
        return data === 'a' ? Promise.reject(lost()) : Promise.resolve()
      },
      { retryable: () => true, giveUpMs: 2_500, now: () => clock }
    )
    push('t1', 'a')
    push('t1', 'b')
    await new Promise((r) => setTimeout(r, 900))
    expect(calls).toEqual(['a', 'a', 'a', 'b'])
  })
})

describe('an answer that refuses the keys', () => {
  it('is told once, with what it refused, and the lane moves on', async () => {
    const refused: Array<[string, string]> = []
    const answers = [Promise.reject(new Error('409')), Promise.resolve()]
    const sent: string[] = []
    const push = createRawInputQueue(
      (_id, data) => {
        sent.push(data)
        return answers.shift() as Promise<unknown>
      },
      { refused: (id, data) => refused.push([id, data]) }
    )
    push('t', 'hello')
    push('t', '\r')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(refused).toEqual([['t', 'hello']])
    expect(sent).toEqual(['hello', '\r'])
  })
  it('a failure with no answer is not a refusal: it goes again', async () => {
    const refused: string[] = []
    const answers = [Promise.reject(new Error('offline')), Promise.resolve()]
    const push = createRawInputQueue(() => answers.shift() as Promise<unknown>, {
      retryable: () => true,
      refused: (_id, data) => refused.push(data)
    })
    push('t', 'x')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(refused).toEqual([])
  })
})
