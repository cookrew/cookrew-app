import { describe, expect, it, vi } from 'vitest'
import { createCatalogRefresh } from '../src/main/magpie-remote/catalog-refresh'

describe('refresh routing after a remote Magpie change', () => {
  it('refreshes immediately and once after the gateway has had time to reload', async () => {
    const jobs: Array<() => void> = []
    const refresh = vi.fn(async () => undefined)
    const catalog = createCatalogRefresh(refresh, (job) => { jobs.push(job); return () => {} })
    await catalog.changed()
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(jobs).toHaveLength(1)
    jobs[0]()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2))
  })

  it('serializes overlapping refreshes and waits for a second pass after a change', async () => {
    let release: () => void = () => {}
    const hold = new Promise<void>((resolve) => { release = resolve })
    const refresh = vi.fn().mockReturnValueOnce(hold).mockResolvedValue(undefined)
    const catalog = createCatalogRefresh(refresh, () => () => {})
    const first = catalog.changed()
    const second = catalog.changed()
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1))
    release()
    await Promise.all([first, second])
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('never changes the connection result when a catalog probe fails', async () => {
    const refresh = vi.fn().mockRejectedValue(new Error('offline'))
    const catalog = createCatalogRefresh(refresh, () => () => {})
    await expect(catalog.changed()).resolves.toBeUndefined()
  })

  it('refreshes only after successful connection changes and preserves the answer', async () => {
    const refresh = vi.fn(async () => undefined)
    const catalog = createCatalogRefresh(refresh, () => () => {})
    const failed = { ok: false as const, why: 'not connected' }
    const success = { ok: true as const, providerId: 'fixture' }
    expect(await catalog.after(async () => failed)).toBe(failed)
    expect(refresh).not.toHaveBeenCalled()
    expect(await catalog.after(async () => success)).toBe(success)
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce())
    await expect(catalog.after(async () => { throw new Error('connection failed') })).rejects.toThrow('connection failed')
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('cancels the follow-up on shutdown', async () => {
    const cancel = vi.fn()
    const catalog = createCatalogRefresh(async () => {}, () => cancel)
    await catalog.changed()
    catalog.dispose()
    expect(cancel).toHaveBeenCalledOnce()
  })
})
