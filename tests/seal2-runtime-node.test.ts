// The runtime check (tests/runtime/seal2-runtime-check.ts) in this suite's own
// Node. scripts/seal-v2-runtimes.mjs runs the same check in Electron's Node and
// in Chrome; watch/Tests runs Swift's against the same vectors.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runSeal2Checks } from './runtime/seal2-runtime-check'

describe('cookrew-seal/2 runtime check', () => {
  it('passes every check here', async () => {
    const report = await runSeal2Checks(JSON.parse(readFileSync('tests/fixtures/seal-v2-vectors.json', 'utf8')), 'vitest')
    expect(report.failed).toEqual([])
    expect(report.passed.length).toBeGreaterThanOrEqual(8)
  })
})
