// SPOTLIGHT WAS READING OUR OWN BROWSER CACHE.
//
// Measured 2026-11-05: of 7,247 files indexed under the home directory in two
// hours, 3,230 were the app's Cache and Code Cache. No root-free marker file
// stops that (.metadata_never_index was indexed anyway, probed); a `.noindex`
// directory name does, and sandboxed Chromium follows a symlink to one as long
// as it stays inside userData (probed in a real Electron; its --disk-cache-dir
// switch moved nothing).
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { keepCachesOutOfIndex } from '../src/main/cache-noindex'

function userData() {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'cache-noindex-')), 'cookrew')
  mkdirSync(dir)
  return dir
}

describe('keepCachesOutOfIndex', () => {
  it('moves a cache that exists, contents and all, and links it back', () => {
    const data = userData()
    mkdirSync(path.join(data, 'Code Cache', 'js'), { recursive: true })
    writeFileSync(path.join(data, 'Code Cache', 'js', 'entry'), 'kept')
    expect(keepCachesOutOfIndex(data, 'darwin')).toEqual(['Cache', 'Code Cache'])
    expect(lstatSync(path.join(data, 'Code Cache')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(path.join(data, 'Code Cache'))).toBe('caches.noindex/Code Cache')
    expect(readFileSync(path.join(data, 'Code Cache', 'js', 'entry'), 'utf8')).toBe('kept')
    expect(realpathSync(path.join(data, 'Code Cache'))).toContain('/caches.noindex/')
  })

  it('links a cache Chromium has not made yet, so it is never born in the index', () => {
    const data = userData()
    keepCachesOutOfIndex(data, 'darwin')
    expect(existsSync(path.join(data, 'Cache'))).toBe(true)
    expect(lstatSync(path.join(data, 'Cache')).isSymbolicLink()).toBe(true)
  })

  it('keeps the real directory inside userData: the sandbox denies the network service anything outside', () => {
    // Review, 2026-11-05: a link to a sibling `<userData>.noindex` passed every
    // page-load probe while `Cache` was dead (ERR_FAILED, 0 files) under the
    // sandbox, and fine under --no-sandbox.
    const data = userData()
    keepCachesOutOfIndex(data, 'darwin')
    expect(realpathSync(path.join(data, 'Cache')).startsWith(`${realpathSync(data)}/`)).toBe(true)
  })

  it('repairs its own link when the directory behind it is gone', () => {
    const data = userData()
    keepCachesOutOfIndex(data, 'darwin')
    rmSync(path.join(data, 'caches.noindex'), { recursive: true })
    keepCachesOutOfIndex(data, 'darwin')
    expect(existsSync(path.join(data, 'Cache'))).toBe(true)
    expect(existsSync(path.join(data, 'Code Cache'))).toBe(true)
  })

  it('does nothing the second time', () => {
    const data = userData()
    keepCachesOutOfIndex(data, 'darwin')
    expect(keepCachesOutOfIndex(data, 'darwin')).toEqual([])
  })

  it('re-homes a plain directory that came back, over the stale copy', () => {
    const data = userData()
    keepCachesOutOfIndex(data, 'darwin')
    const link = path.join(data, 'Cache')
    const stale = path.join(data, 'caches.noindex', 'Cache', 'stale')
    writeFileSync(stale, 'old')
    // A clear can delete the link; Chromium then makes a real directory there.
    rmSync(link)
    mkdirSync(link)
    writeFileSync(path.join(link, 'fresh'), 'new')
    expect(keepCachesOutOfIndex(data, 'darwin')).toEqual(['Cache'])
    expect(existsSync(path.join(link, 'fresh'))).toBe(true)
    expect(existsSync(path.join(link, 'stale'))).toBe(false)
  })

  it('leaves a symlink somebody else made alone', () => {
    const data = userData()
    symlinkSync('/somewhere/else', path.join(data, 'Cache'))
    keepCachesOutOfIndex(data, 'darwin')
    expect(readlinkSync(path.join(data, 'Cache'))).toBe('/somewhere/else')
  })

  it('is a macOS answer to a macOS problem', () => {
    const data = userData()
    expect(keepCachesOutOfIndex(data, 'linux')).toEqual([])
    expect(existsSync(`${data}.noindex`)).toBe(false)
  })

  it('never throws: a cache in the index is no reason not to boot', () => {
    expect(keepCachesOutOfIndex('/dev/null/nope', 'darwin')).toEqual([])
  })
})
