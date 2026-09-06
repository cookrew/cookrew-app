import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** Set per test: whether the mocked utimesSync throws. */
const stage: { utimesThrows: boolean } = { utimesThrows: false }

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    utimesSync: ((...args: unknown[]) => {
      if (stage.utimesThrows) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
      return (actual.utimesSync as (...a: unknown[]) => unknown)(...args)
    }) as typeof actual.utimesSync
  }
})

import { sandboxRoot } from '../src/main/session-sandbox'

const made: string[] = []
afterEach(() => {
  stage.utimesThrows = false
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('sandboxRoot — the mtime refresh is cosmetic for the mint', () => {
  it('refreshes an existing directory when it can', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-mint-'))
    made.push(base)
    const dir = sandboxRoot(base, 'svc-a', 'svc-a-ana-1')
    expect(Date.now() - statSync(dir).mtimeMs).toBeLessThan(60_000)
  })

  it('still mints when the refresh throws', () => {
    const base = mkdtempSync(path.join(tmpdir(), 'cookrew-mint-'))
    made.push(base)
    stage.utimesThrows = true
    expect(() => sandboxRoot(base, 'svc-a', 'svc-a-ana-1')).not.toThrow()
    expect(statSync(path.join(base, 'sessions', 'svc-a', 'ana-1')).isDirectory()).toBe(true)
  })
})
