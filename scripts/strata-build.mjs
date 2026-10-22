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
//
// THE FRONT PAGE'S SAMPLE FLEET rides in the same bundle: after the shell,
// registry/src/site-art.ts draws its six pictures with the same figure kit
// into assets/art/ and writes site-art.json beside index.html, which the
// registry reads at boot (site-art-manifest.ts). The kit stays out of the
// registry's own bundle that way.
import { build } from 'vite'
import { build as bundle } from 'esbuild'
import react from '@vitejs/plugin-react'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const scratch = mkdtempSync(path.join(tmpdir(), 'strata-site-art-'))
try {
  const composer = path.join(scratch, 'site-art.mjs')
  await bundle({ entryPoints: [path.join(tree, 'registry', 'src', 'site-art.ts')], bundle: true, platform: 'node', format: 'esm', outfile: composer, logLevel: 'warning' })
  const { composeSampleArt, ART_MANIFEST } = await import(pathToFileURL(composer).href)
  const { files, manifest } = composeSampleArt()
  for (const [rel, svg] of Object.entries(files)) {
    const file = path.join(outDir, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, svg)
  }
  writeFileSync(path.join(outDir, ART_MANIFEST), JSON.stringify(manifest))
  const bytes = Object.values(files).reduce((sum, svg) => sum + svg.length, 0)
  console.log(`strata shell: ${outDir} (+ ${Object.keys(files).length} sample pictures, ${(bytes / 1024).toFixed(0)} KB)`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
