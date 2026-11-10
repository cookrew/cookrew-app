import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

/**
 * THE CONSOLE, BUILT (`npm run console:build`), is what a static host is
 * handed: this builds it once into a scratch directory and holds the files to
 * what the host and the page rely on. Then the size gate is run over it.
 */

const root = path.resolve(__dirname, '..')
const scratch = mkdtempSync(path.join(os.tmpdir(), 'cookrew-console-build-'))
const out = path.join(scratch, 'console')
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('COOKREW_')))
const run = (args: string[], env: Record<string, string> = {}): { status: number | null; said: string } => {
  const done = spawnSync(process.execPath, args, { cwd: root, env: { ...clean, ...env }, encoding: 'utf8', timeout: 180_000 })
  return { status: done.status, said: `${done.stdout}${done.stderr}` }
}
// Found the way node finds it: a linked worktree has no node_modules of its own.
const vite = path.join(path.dirname(createRequire(__filename).resolve('vite/package.json')), 'bin', 'vite.js')
const built = run([vite, 'build', '-c', 'vite.console.config.ts', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { COOKREW_CONSOLE_VERSION: '0.6.0' })
const file = (name: string): string => readFileSync(path.join(out, name), 'utf8')

describe('the built console', () => {
  it('builds', () => {
    expect(built.status, built.said).toBe(0)
  })

  it('is one page, with no 404 page beside it: the host then answers every address with the page', () => {
    expect(existsSync(path.join(out, 'index.html'))).toBe(true)
    expect(existsSync(path.join(out, '404.html'))).toBe(false)
  })

  it('tells the host its policy, with the API host it was built for', () => {
    const headers = file('_headers')
    expect(headers).toContain("script-src 'self'")
    expect(headers).toContain("connect-src 'self' https://api.cookrew.dev https://*.d.cookrew.dev:8643 wss://*.d.cookrew.dev:8643")
    expect(headers).toMatch(/\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/)
  })

  it('pins every script and style the page starts with to the bytes that were written', () => {
    const page = file('index.html')
    const pinned = [...page.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"[^>]*>/g)]
    expect(pinned.length).toBeGreaterThan(0)
    for (const [tag, name] of pinned) {
      const digest = createHash('sha384').update(readFileSync(path.join(out, name))).digest('base64')
      expect(tag, name).toContain(`integrity="sha384-${digest}"`)
      expect(tag, name).toContain('crossorigin')
    }
    expect(page).not.toMatch(/<script\b(?![^>]*\bsrc=)/)
  })

  it('says which build it is, the same in the page, the version file and the worker', () => {
    const version = JSON.parse(file('version.json')) as { version: string; build: string }
    expect(version.version).toBe('0.6.0')
    expect(version.build).toMatch(/^[0-9a-f]{12}$/)
    expect(file('index.html')).toContain(`<meta name="cookrew-build" content="${version.build}"`)
    expect(file('sw.js')).toContain(`cookrew-console-0.6.0-${version.build}`)
    // The worker holds the page's files and none of the host's own: those are not served as files.
    expect(file('sw.js')).not.toContain('/_headers')
    expect(file('sw.js')).not.toContain('/version.json')
  })

  it('passes the size gate, and the gate fails a page that is over its limit', () => {
    const size = path.join(root, 'scripts', 'console-size.mjs')
    const passed = run([size, out])
    expect(passed.status, passed.said).toBe(0)
    expect(passed.said).toMatch(/first load: \d+(\.\d+)? KB/)
    const failed = run([size, out, '--limit-kb', '1'])
    expect(failed.status).not.toBe(0)
    expect(failed.said).toMatch(/over/)
  })
})
