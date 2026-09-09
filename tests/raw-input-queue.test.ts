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
