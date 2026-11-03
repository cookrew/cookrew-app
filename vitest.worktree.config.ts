// RUNNING THIS WORKTREE'S OWN TESTS.
//
// vitest.config.ts excludes every linked worktree on purpose: a run from the
// main tree must never collect another branch's tests. Inside a worktree that
// same exclude hides the worktree's OWN tests too, so a lane has no way to run
// what it just wrote — and the tempting workaround (a root run with the exclude
// dropped) is the 536-second, twenty-false-failure run the app's config exists
// to prevent. This is the app's config, rooted here, minus only that line:
//
//   npx vitest run --config vitest.worktree.config.ts
//
// It names the suites it runs, so it cannot quietly grow into a whole-suite run.
import { defineConfig } from 'vitest/config'

const ROOT = new URL('.', import.meta.url).pathname

export default defineConfig({
  root: ROOT,
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/zoom-*.test.ts', 'tests/zoom-*.test.tsx', 'tests/agent-pets.test.ts', 'tests/pet-morph.test.ts', 'tests/header-route.test.tsx', 'tests/night-scheme.test.ts', 'tests/header-layer.test.ts', 'tests/levels-removed.test.ts', 'tests/pet-dock.test.ts', 'tests/pet-strip-row.test.ts', 'tests/phone-header-bar.test.ts', 'tests/header-dial-gives.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/out/**']
  }
})
