#!/usr/bin/env node
/**
 * The Electron shell's build (D0 step 3): src/main/shell/index.ts written to
 * out/shell/index.js, beside out/daemon (scripts/daemon-build.mjs builds it
 * too, first). The shell needs out/preload and out/renderer, which `npm run
 * build` makes.
 *
 *   node scripts/shell-build.mjs
 *   npm run shell:smoke           build both and drive the shell, isolated
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

try {
  execFileSync(process.execPath, [path.join(root, 'scripts/daemon-build.mjs')], { stdio: 'inherit' })
  await build({
    entryPoints: { index: path.join(root, 'src/main/shell/index.ts') },
    outdir: path.join(root, 'out/shell'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    sourcemap: 'linked',
    logLevel: 'warning'
  })
  console.log('cookrew shell: out/shell/index.js')
} catch (error) {
  console.error('cookrew shell build failed:', error)
  process.exit(1)
}
