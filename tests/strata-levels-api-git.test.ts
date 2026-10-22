import { describe, expect, it } from 'vitest'
import { GitInfoCache } from '../src/main/git'
import type { GitInfo } from '../src/shared/model'

const INFO: GitInfo = { isRepo: true, root: '/work/invented', branch: 'main', dirty: false, ahead: 0, behind: 0 }

describe('GitInfoCache.peek, for the levels detail', () => {
  it('never queries, and answers only a settled, fresh result', async () => {
    let queries = 0
    let release: (info: GitInfo) => void = () => undefined
    const cache = new GitInfoCache(
      () =>
        new Promise<GitInfo>((resolve) => {
          queries += 1
          release = resolve
        })
    )
    expect(cache.peek('/work/invented', 1_000)).toBeUndefined()
    expect(queries).toBe(0)
    const pending = cache.info('/work/invented', 1_000)
    expect(cache.peek('/work/invented', 1_000)).toBeUndefined()
    release(INFO)
    await pending
    expect(cache.peek('/work/invented', 1_001)).toEqual(INFO)
    expect(cache.peek('/work/invented', 1_000 + 3_600_000)).toBeUndefined()
    expect(queries).toBe(1)
  })
})
