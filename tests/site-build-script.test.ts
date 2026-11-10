import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `npm run site:build` WRITES cookrew.dev TO A DIRECTORY (scripts/site-build.mjs).
 * What the pages are is site-static.test.ts; this is the part that touches a
 * disk: the files land where the host looks for them, the fonts are the real
 * ones, every picture a page names is in the repository, and the build clears
 * only a directory that a build made.
 *
 * Run offline: GitHub is asked nothing, so no release is named.
 */

const root = path.resolve(__dirname, '..')
const scratch = mkdtempSync(path.join(os.tmpdir(), 'cookrew-site-build-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function run(out: string, env: Record<string, string> = {}): { status: number | null; said: string } {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('COOKREW_')))
  const done = spawnSync(process.execPath, [path.join(root, 'scripts/site-build.mjs'), '--out', out], {
    cwd: root,
    env: { ...clean, COOKREW_SITE_OFFLINE: '1', ...env },
    encoding: 'utf8',
    timeout: 60_000
  })
  return { status: done.status, said: `${done.stdout}${done.stderr}` }
}

describe('the site, written to a directory', () => {
  const out = path.join(scratch, 'site')
  const built = run(out)

  it('builds offline, and says no release is named', () => {
    expect(built.said).toContain('no release')
    expect(built.status, built.said).toBe(0)
  })

  it('writes the pages as flat files beside the host’s two rule files', () => {
    for (const name of ['index.html', '404.html', 'open.html', 'join.html', 'features/canvas.html', '_headers', '_redirects', 'robots.txt', 'sitemap.xml', 'llms.txt', 'favicon.svg', 'site.webmanifest']) {
      expect(existsSync(path.join(out, name)), name).toBe(true)
    }
    expect(readFileSync(path.join(out, 'index.html'), 'utf8')).toContain('href="https://console.cookrew.dev/"')
    expect(readFileSync(path.join(out, '_redirects'), 'utf8')).toContain('/me https://console.cookrew.dev/ 302')
  })

  it('ships the repository’s own font files, byte for byte', () => {
    for (const font of ['inter.woff2', 'jetbrains-mono.woff2']) {
      expect(readFileSync(path.join(out, 'assets', font)).equals(readFileSync(path.join(root, 'registry/assets/fonts', font))), font).toBe(true)
    }
    expect(readdirSync(path.join(out, 'assets')).sort()).toEqual(['inter.woff2', 'jetbrains-mono.woff2'])
  })

  it('names pictures at the commit it was built from, and every one of them is in the repository', () => {
    const home = readFileSync(path.join(out, 'index.html'), 'utf8')
    const named = [...home.matchAll(/https:\/\/raw\.githubusercontent\.com\/cookrew\/cookrew-app\/([0-9a-f]{40})\/registry\/assets\/site\/([A-Za-z0-9._-]+)/g)]
    expect(named.length).toBeGreaterThan(0)
    for (const [, , file] of named) expect(existsSync(path.join(root, 'registry/assets/site', file)), file).toBe(true)
    expect(new Set(named.map(([, ref]) => ref)).size).toBe(1)
  })

  it('is built for the console and the auth host it is told, and for no address that is not an https origin', () => {
    const other = path.join(scratch, 'other')
    const told = run(other, { COOKREW_CONSOLE_ORIGIN: 'https://console.example.test', COOKREW_AUTH_ORIGIN: 'https://auth.example.test' })
    expect(told.status, told.said).toBe(0)
    expect(readFileSync(path.join(other, '_redirects'), 'utf8')).toContain('/me/account https://auth.example.test/account 302')
    const bad = run(path.join(scratch, 'bad'), { COOKREW_CONSOLE_ORIGIN: 'http://console.example.test' })
    expect(bad.status).not.toBe(0)
    expect(existsSync(path.join(scratch, 'bad', 'index.html'))).toBe(false)
  })

  it('builds again over its own output, and leaves a directory it did not make alone', () => {
    writeFileSync(path.join(out, 'stale.html'), 'left by the last build')
    expect(run(out).status).toBe(0)
    expect(existsSync(path.join(out, 'stale.html'))).toBe(false)

    const theirs = path.join(scratch, 'theirs')
    mkdirSync(theirs)
    writeFileSync(path.join(theirs, 'notes.txt'), 'not a build')
    const refused = run(theirs)
    expect(refused.status).not.toBe(0)
    expect(readFileSync(path.join(theirs, 'notes.txt'), 'utf8')).toBe('not a build')
  })

  it('stops when a release is required and none can be read', () => {
    const required = run(path.join(scratch, 'required'), { COOKREW_SITE_REQUIRE_RELEASE: '1' })
    expect(required.status).not.toBe(0)
    expect(required.said).toMatch(/release/i)
  })
})
