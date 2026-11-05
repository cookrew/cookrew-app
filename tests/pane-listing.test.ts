import { describe, expect, it, vi } from 'vitest'
import { sharedListing } from '../src/main/pane-listing'

// Closing twenty cards polled the pane list twenty times a tick, inline on the
// main thread. One listing answers every close waiting on it.
describe('sharedListing', () => {
  it('callers in the same moment share one read', async () => {
    const read = vi.fn(async () => new Set(['a']))
    const listing = sharedListing(read, 100, () => 0)
    const answers = await Promise.all([listing(), listing(), listing()])
    expect(read).toHaveBeenCalledTimes(1)
    expect(answers[2]).toEqual(new Set(['a']))
  })

  it('reads again once its answer is old', async () => {
    let clock = 0
    const read = vi.fn(async () => new Set<string>())
    const listing = sharedListing(read, 100, () => clock)
    await listing()
    clock = 99
    await listing()
    clock = 100
    await listing()
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('a failure is not kept: the next caller asks again', async () => {
    let fail = true
    const listing = sharedListing(
      async () => {
        if (fail) throw new Error('down')
        return new Set(['a'])
      },
      100,
      () => 0
    )
    await expect(listing()).rejects.toThrow('down')
    fail = false
    await expect(listing()).resolves.toEqual(new Set(['a']))
  })
})
