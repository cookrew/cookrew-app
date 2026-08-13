import { describe, expect, it, vi } from 'vitest'
import { retry } from '../src/renderer/src/retry'

const noSleep = (): Promise<void> => Promise.resolve()

describe('retry', () => {
  it('returns the first success without waiting', async () => {
    const attempt = vi.fn(async () => 'state')
    const sleep = vi.fn(noSleep)
    await expect(retry(attempt, { sleep })).resolves.toBe('state')
    expect(attempt).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('keeps asking until the canvas gets its state — the phone-wakes case', async () => {
    let calls = 0
    const attempt = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new Error('Failed to fetch')
      return 'state'
    })
    await expect(retry(attempt, { sleep: noSleep, delaysMs: [1, 2, 3] })).resolves.toBe('state')
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('waits the given ladder between attempts', async () => {
    const waited: number[] = []
    const attempt = vi.fn(async () => {
      throw new Error('down')
    })
    await expect(
      retry(attempt, {
        delaysMs: [10, 20],
        sleep: async (ms) => void waited.push(ms)
      })
    ).rejects.toThrow('down')
    expect(waited).toEqual([10, 20])
    expect(attempt).toHaveBeenCalledTimes(3)
  })

  it('gives up on an expired pairing token instead of hammering', async () => {
    const authError = Object.assign(new Error('Unauthorized'), { name: 'AuthError' })
    const attempt = vi.fn(async () => {
      throw authError
    })
    await expect(retry(attempt, { sleep: noSleep, delaysMs: [1, 2] })).rejects.toBe(authError)
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('honours a retryable rule the caller supplies', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('nope')
    })
    await expect(
      retry(attempt, { sleep: noSleep, delaysMs: [1], retryable: () => false })
    ).rejects.toThrow('nope')
    expect(attempt).toHaveBeenCalledTimes(1)
  })
})
