import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SERVED_GRACE_MS } from '../scripts/perf-eval-lib.mjs'

/**
 * The eval reports "served sessions past grace" as what the next boot sweep
 * reclaims. That is only true while its grace equals the sweep's. The eval
 * is plain JS copied to ~/.cookrew/bin and cannot import the TypeScript
 * constant, so the number is spelled twice — and this reads the sweep's
 * spelling out of its SOURCE, so a change to either side fails here rather
 * than reporting as reclaimable what the sweep will not take.
 */
describe('the eval and the sweep agree on the served-session grace', () => {
  it('SERVED_GRACE_MS equals DEFAULT_GRACE_MS as written in storage-gc-scan.ts', () => {
    const source = readFileSync(path.join(__dirname, '..', 'src', 'main', 'storage-gc-scan.ts'), 'utf8')
    const day = /const DAY = (\d+) \* (\d+) \* (\d+) \* (\d+)\n/.exec(source)
    const grace = /export const DEFAULT_GRACE_MS = (\d+) \* DAY\n/.exec(source)
    expect(day, 'DAY is no longer spelled h * m * s * ms in storage-gc-scan.ts').not.toBeNull()
    expect(grace, 'DEFAULT_GRACE_MS is no longer spelled N * DAY in storage-gc-scan.ts').not.toBeNull()
    const dayMs = day!.slice(1, 5).map(Number).reduce((a, b) => a * b, 1)
    expect(Number(grace![1]) * dayMs).toBe(SERVED_GRACE_MS)
  })
})
