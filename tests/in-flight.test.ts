// ONE AT A TIME OVER A SCARCE LINE (in-flight.ts). Measured 2026-11-05: while
// the Mac stalled, five beacons and six taps on one tile held eleven of the
// relay's sixteen exchanges, and the next tap was refused.
import { describe, expect, it, vi } from 'vitest'
import { joinInFlight, skipWhileOut } from '../src/renderer/src/in-flight'

/** A promise settled by hand, as an answer from a stalled Mac is. */
const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } => {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('skipWhileOut', () => {
  it('sends nothing more while the last one is unanswered', () => {
    const task = vi.fn(() => deferred<void>().promise)
    const tick = skipWhileOut(task, 30_000, () => 0)
    tick()
    tick()
    tick()
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('sends again once the last one is answered', async () => {
    const answers = [deferred<void>(), deferred<void>()]
    let call = 0
    const task = vi.fn(() => answers[call++].promise)
    const tick = skipWhileOut(task, 30_000, () => 0)
    tick()
    answers[0].resolve()
    await settled()
    tick()
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('counts a failure as an answer', async () => {
    const task = vi.fn(() => Promise.reject(new Error('Failed to fetch')))
    const tick = skipWhileOut(task, 30_000, () => 0)
    tick()
    await settled()
    tick()
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('does not stay silent forever behind one that never settles', () => {
    let now = 0
    const task = vi.fn(() => deferred<void>().promise)
    const tick = skipWhileOut(task, 30_000, () => now)
    tick()
    now = 29_999
    tick()
    expect(task).toHaveBeenCalledTimes(1)
    now = 30_000
    tick()
    expect(task).toHaveBeenCalledTimes(2)
  })

  it('a late answer does not release the one sent after it', async () => {
    let now = 0
    const answers = [deferred<void>(), deferred<void>()]
    let call = 0
    const task = vi.fn(() => answers[call++].promise)
    const tick = skipWhileOut(task, 30_000, () => now)
    tick()
    now = 30_000
    tick()
    answers[0].resolve()
    await settled()
    tick()
    expect(task).toHaveBeenCalledTimes(2)
  })
})

describe('joinInFlight', () => {
  it('sends one request for the same key, and answers everyone', async () => {
    const answer = deferred<string>()
    const run = vi.fn((_key: string) => answer.promise)
    const open = joinInFlight(run, 30_000)
    const taps = [open('w1'), open('w1'), open('w1')]
    answer.resolve('switched')
    await expect(Promise.all(taps)).resolves.toEqual(['switched', 'switched', 'switched'])
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps different keys apart', () => {
    const run = vi.fn((_key: string) => deferred<string>().promise)
    const open = joinInFlight(run, 30_000)
    void open('w1')
    void open('w2')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('does not pin a key behind one that never settles', () => {
    vi.useFakeTimers()
    try {
      const run = vi.fn((_key: string) => deferred<string>().promise)
      const open = joinInFlight(run, 30_000)
      void open('w1')
      vi.advanceTimersByTime(29_999)
      void open('w1')
      expect(run).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      void open('w1')
      expect(run).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('asks afresh once the last one settled, either way', async () => {
    const run = vi.fn(async (key: string) => {
      if (run.mock.calls.length === 1) throw new Error('refused')
      return key
    })
    const open = joinInFlight(run, 30_000)
    await expect(open('w1')).rejects.toThrow('refused')
    await expect(open('w1')).resolves.toBe('w1')
    expect(run).toHaveBeenCalledTimes(2)
  })
})
