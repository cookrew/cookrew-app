import { defineConfig } from 'vitest/config'
const ROOT = new URL('.', import.meta.url).pathname
export default defineConfig({ root: ROOT, esbuild: { jsx: 'automatic' }, test: { include: ['tests/cli-workspace.test.ts', 'tests/browser-workspace-scope.test.ts'], exclude: ['**/node_modules/**', '**/dist/**', '**/out/**'] } })
