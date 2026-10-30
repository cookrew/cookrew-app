// KEEP THE LAST FEW BUILDS' CHUNKS (scripts/keep-recent-chunks.mjs): a page
// loaded before a rebuild must still find its chunks; a release ships only
// its own.
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- plain .mjs build helper
import { KEEP_MS, isReleaseBuild, pruneAssets } from '../scripts/keep-recent-chunks.mjs'

const NOW = Date.parse('2026-10-31T06:00:00Z')

function outDir(files: Record<string, number>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'keep-chunks-'))
  mkdirSync(path.join(dir, 'assets'))
  for (const [name, ageMs] of Object.entries(files)) {
    const file = path.join(dir, 'assets', name)
    writeFileSync(file, 'x')
    const at = (NOW - ageMs) / 1000
    utimesSync(file, at, at)
  }
  return dir
}

describe('pruneAssets', () => {
  it('keeps this build and the recent ones, removes what is older than the window', () => {
    const dir = outDir({ 'App-new.js': 0, 'App-earlier.js': 20 * 60_000, 'App-yesterday.js': KEEP_MS + 1 })
    const removed = pruneAssets(dir, new Set(['assets/App-new.js']), { now: NOW })
    expect(removed).toEqual(['App-yesterday.js'])
    expect(existsSync(path.join(dir, 'assets', 'App-earlier.js'))).toBe(true)
    expect(existsSync(path.join(dir, 'assets', 'App-new.js'))).toBe(true)
  })

  it('a release keeps only its own chunks', () => {
    const dir = outDir({ 'App-new.js': 0, 'App-earlier.js': 60_000 })
    expect(pruneAssets(dir, new Set(['assets/App-new.js']), { now: NOW, release: true })).toEqual(['App-earlier.js'])
  })

  it('no assets folder is nothing to do', () => {
    expect(pruneAssets(mkdtempSync(path.join(tmpdir(), 'keep-chunks-empty-')), new Set(), { now: NOW })).toEqual([])
  })

  it('a release is any npm dist script', () => {
    expect(['dist', 'dist:mac', 'dist:win'].every((s) => isReleaseBuild(s))).toBe(true)
    expect(isReleaseBuild('build')).toBe(false)
    expect(isReleaseBuild(undefined)).toBe(false)
  })
})
