import { defineConfig } from 'vitest/config'

/**
 * The perf suite: tests/perf/*.perf.ts, and nothing else.
 *
 * Kept out of `npm test` on purpose. These gates time things and measure
 * retained heap, so they want a quiet process and a quiet machine; run in
 * the middle of the 4,600-test suite they would both slow it and read its
 * contention as a regression. They run on their own (`npm run test:perf`),
 * nightly in CI (.github/workflows/perf.yml), and whenever tests/perf/ or
 * budgets change.
 *
 * `.perf.ts`, not `.test.ts`: vitest.config.ts collects `tests/**\/*.test.ts`,
 * so the suffix is what keeps the two suites apart without either config
 * having to know about the other.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/perf/**/*.perf.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**', '**/.claude/worktrees/**'],
    // One file at a time, in its own process: a heap gate needs the heap to
    // itself, and a latency gate needs the CPU to itself.
    fileParallelism: false,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
        // heapGrowth() in tests/perf/perf-harness.ts collects before and
        // after; without a real collection the "retained" number is noise.
        execArgv: ['--expose-gc']
      }
    },
    // The live-shaped event log alone writes ~16 MB before its first sample.
    testTimeout: 180_000,
    hookTimeout: 180_000
  }
})
