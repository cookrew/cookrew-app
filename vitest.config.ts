import { defineConfig } from 'vitest/config'

/**
 * The suite is THIS tree's tests, and nobody else's.
 *
 * There was no config file at all, so vitest ran on its defaults — and its
 * default `include` is `**\/*.test.ts` from the root, which walks into
 * `.claude/worktrees/`. Every linked worktree carries a full copy of `tests/`,
 * so a root run executed every branch's suite at once: measured on this
 * machine, 55,705 tests in 536s with 20 failures, against 3,361 in 22s with 1
 * when the worktrees are left out.
 *
 * Three separate harms, and the speed was the least of them:
 *
 *   WRONG SIGNAL. Another branch's breakage failed YOUR run. Twenty of those
 *   twenty failures belonged to branches under review, not to dev, so "the
 *   suite is red" stopped being information about the tree you were in.
 *
 *   WRONG NUMBERS. Every "N green" this program has quoted — mine included —
 *   was counting other branches' trees, and the count moved whenever somebody
 *   else added or removed a worktree. A number that changes because a
 *   colleague started a branch is not a measurement.
 *
 *   REAL CONTENTION. The heaviest tests ran once per worktree, concurrently:
 *   fifteen copies of the 51 MB fold-async ledger writing and polling at the
 *   same time is what turned that test's 0.6s fold into a 60s timeout, which
 *   was then filed and re-filed as a flake in the test itself.
 *
 * Excluding them is not hiding anything: a worktree's tests belong to that
 * worktree, and running them there is the point of having one.
 */
export default defineConfig({
  test: {
    // Only this tree's suite. Named explicitly rather than left to the default
    // root walk, so a new directory of fixtures cannot quietly join the run.
    include: ['tests/**/*.test.ts'],
    exclude: [
      // Vitest's defaults are REPLACED, not merged, when `exclude` is set —
      // so node_modules has to be restated here or it comes back.
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      // The linked worktrees. Each is a checkout of this same repo, so its
      // tests/ mirrors ours and the default walk collected all of them.
      '**/.claude/worktrees/**'
    ]
  }
})
