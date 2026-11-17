import { defineConfig } from 'vitest/config'
import { testWorkers, WORKER_GUARD, yieldToAgents } from './scripts/heavy-slot.mjs'
const ROOT = new URL('.', import.meta.url).pathname
yieldToAgents()
export default defineConfig({ root: ROOT, esbuild: { jsx: 'automatic' }, test: { minWorkers: 1, maxWorkers: testWorkers(), setupFiles: WORKER_GUARD.setupFiles, poolOptions: { forks: { execArgv: WORKER_GUARD.execArgv } }, include: ['tests/cli-workspace.test.ts', 'tests/browser-workspace-scope.test.ts'], exclude: ['**/node_modules/**', '**/dist/**', '**/out/**'] } })
