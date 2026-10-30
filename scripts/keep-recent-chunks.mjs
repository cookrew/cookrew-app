// KEEP THE LAST FEW BUILDS' CHUNKS (renderer build plugin, electron.vite.config.ts).
//
// Every merge rebuilds out/renderer, and the build used to empty it first.
// The companion that phones load through cookrew.dev is that build, with its
// chunks served under hashed, forever-cached names — so a page loaded before
// a rebuild asked for an App chunk that had just been deleted, got a 404, and
// fell into the crash screen (owner's phone, 2026-10-31 05:51). Now an
// everyday build leaves earlier chunks in place for KEEP_MS and prunes what is
// older; a release build (`npm run dist*`) keeps only its own, so nothing
// stale is ever packaged.

import { readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'

export const KEEP_MS = 12 * 60 * 60 * 1000

/**
 * Remove the files under <outDir>/assets that this build did not write and
 * that are older than keepMs (all of them, for a release). Returns the names
 * removed. `current` holds the bundle's file names, e.g. "assets/App-x.js".
 */
export function pruneAssets(outDir, current, { keepMs = KEEP_MS, now = Date.now(), release = false } = {}) {
  const dir = path.join(outDir, 'assets')
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const removed = []
  for (const name of names) {
    if (current.has(`assets/${name}`)) continue
    const file = path.join(dir, name)
    let mtime = 0
    try {
      mtime = statSync(file).mtimeMs
    } catch {
      continue
    }
    if (!release && now - mtime < keepMs) continue
    rmSync(file, { force: true })
    removed.push(name)
  }
  return removed
}

export const isReleaseBuild = (event = process.env.npm_lifecycle_event) => typeof event === 'string' && event.startsWith('dist')

export function keepRecentChunks(options = {}) {
  return {
    name: 'cookrew-keep-recent-chunks',
    apply: 'build',
    writeBundle(output, bundle) {
      if (!output.dir) return
      pruneAssets(output.dir, new Set(Object.keys(bundle)), { ...options, release: options.release ?? isReleaseBuild() })
    }
  }
}
