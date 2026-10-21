#!/usr/bin/env node
// Strata shell build for the registry's second bundle (D3): src/strata built
// with base /strata/, so every file is asked for under /strata/. The registry
// serves the built index.html at /me and the rest at /strata/<file>
// (scripts/registry-assets.mjs --shell <out> packs this directory).
//
//   npm run strata:build -- [--out out/strata-shell]
//
// --out is emptied first, so it must sit under out/ or /tmp. The dep cache
// lives in /tmp, as the preview's does (scripts/strata-preview.mjs).
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const at = process.argv.indexOf('--out')
const outDir = path.resolve(tree, at > 0 && process.argv[at + 1] ? process.argv[at + 1] : 'out/strata-shell')
const SAFE_ROOTS = [path.join(tree, 'out') + path.sep, '/tmp/', '/private/tmp/']
if (!SAFE_ROOTS.some((root) => outDir.startsWith(root))) {
  throw new Error(`--out is emptied before the build, so it must be under out/ or /tmp: ${outDir}`)
}

await build({
  root: path.join(tree, 'src', 'strata'),
  base: '/strata/',
  cacheDir: '/tmp/strata-vite-cache-build',
  configFile: false,
  logLevel: 'warn',
  plugins: [react()],
  build: { outDir, emptyOutDir: true }
})
console.log(`strata shell: ${outDir}`)
