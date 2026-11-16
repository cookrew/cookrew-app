#!/usr/bin/env node
/**
 * cookrewd's build (D0 of the move off Electron): src/main bundled with
 * `electron` aliased to src/main/daemon/electron-shim.ts, entered through
 * src/main/daemon/entry.ts (which refuses to boot unless isolated), written to
 * out/daemon/index.js: the same depth as out/main/index.js, so the code's
 * relative paths (../renderer, ../../resources, ../../cli) still land.
 *
 *   node scripts/daemon-build.mjs            build
 *   npm run daemon:smoke                     build and run it, isolated
 *
 * Do not start out/daemon/index.js by hand: it shares the live app's world
 * unless a launcher isolates it, and entry.ts will refuse. COOKREWD_OUTDIR
 * writes elsewhere (the unit test builds into a temp folder).
 */
import { build } from 'esbuild'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const shim = path.join(root, 'src/main/daemon/electron-shim.ts')
const outdir = process.env.COOKREWD_OUTDIR ?? path.join(root, 'out/daemon')

/** Resolves `electron` to the shim before esbuild decides what is external. */
const electronShim = {
  name: 'electron-shim',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: shim }))
  }
}

try {
  await build({
    entryPoints: {
      index: path.join(root, 'src/main/daemon/entry.ts'),
      'storage-gc-worker': path.join(root, 'src/main/storage-gc-worker-entry.ts')
    },
    outdir,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    plugins: [electronShim],
    sourcemap: 'linked',
    logLevel: 'warning',
    banner: {
      // Bundled ESM still meets require() in some dependencies' CJS paths. A
      // global rather than a top-level `const require`, so no bundled module's
      // own `require` can collide with it.
      js: "import { createRequire as __cookrewdCreateRequire } from 'node:module'; globalThis.require ??= __cookrewdCreateRequire(import.meta.url);"
    }
  })
  console.log(`cookrewd: ${path.relative(root, path.join(outdir, 'index.js'))}`)
} catch (error) {
  console.error('cookrewd build failed:', error)
  process.exit(1)
}
