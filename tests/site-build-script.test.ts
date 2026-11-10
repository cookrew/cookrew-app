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

function run(out: string, env: Record<string, string> = {}, cwd: string = root): { status: number | null; said: string } {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('COOKREW_')))
  const done = spawnSync(process.execPath, [path.join(root, 'scripts/site-build.mjs'), '--out', out], {
    cwd,
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

  it('does not take another static site for its own: the two file names every such site has are not proof', () => {
    const other = path.join(scratch, 'another-site')
    mkdirSync(other)
    writeFileSync(path.join(other, '_headers'), '/*\n  X-Frame-Options: DENY\n')
    writeFileSync(path.join(other, 'index.html'), '<h1>somebody else</h1>')
    expect(run(other).status).not.toBe(0)
    expect(readFileSync(path.join(other, 'index.html'), 'utf8')).toBe('<h1>somebody else</h1>')
  })

  it('leaves no half-made directory and no build beside it', () => {
    expect(readdirSync(scratch).filter((name) => name.includes('.building'))).toEqual([])
  })

  it('writes --out where the caller stands, not where the script lives', () => {
    const stand = path.join(scratch, 'stand')
    mkdirSync(stand)
    expect(run('made-here', {}, stand).status).toBe(0)
    expect(existsSync(path.join(stand, 'made-here', 'index.html'))).toBe(true)
  })

  it('stops when a release is required and none can be read, and the last good build stays', () => {
    const required = run(out, { COOKREW_SITE_REQUIRE_RELEASE: '1' })
    expect(required.status).not.toBe(0)
    expect(required.said).toMatch(/release/i)
    expect(existsSync(path.join(out, 'index.html'))).toBe(true)
  })

  it('takes a switch as 1 or 0 and stops on anything else, so a gate cannot be left off by a spelling', () => {
    const spelled = run(path.join(scratch, 'spelled'), { COOKREW_SITE_REQUIRE_RELEASE: 'true' })
    expect(spelled.status).not.toBe(0)
    expect(spelled.said).toContain('COOKREW_SITE_REQUIRE_RELEASE')
    expect(run(path.join(scratch, 'zero'), { COOKREW_SITE_REQUIRE_RELEASE: '0' }).status).toBe(0)
  })

  it('stops for a release that is named and is not a tag, and for one that is named and cannot be read', () => {
    const odd = run(path.join(scratch, 'odd'), { COOKREW_SITE_RELEASE: 'latest' })
    expect(odd.status).not.toBe(0)
    expect(odd.said).toContain('COOKREW_SITE_RELEASE')
    // Offline nothing can be read: a release that was asked for by name is not quietly left out.
    const named = run(path.join(scratch, 'named'), { COOKREW_SITE_RELEASE: 'v0.6.0' })
    expect(named.status).not.toBe(0)
    expect(named.said).toContain('v0.6.0')
  })

  it('stops when the commit the pictures are read at does not hold them', () => {
    const nowhere = run(path.join(scratch, 'nowhere'), { COOKREW_SITE_REF: '0'.repeat(40) })
    expect(nowhere.status).not.toBe(0)
    expect(nowhere.said).toMatch(/commit/i)
    expect(existsSync(path.join(scratch, 'nowhere'))).toBe(false)
  })
})
