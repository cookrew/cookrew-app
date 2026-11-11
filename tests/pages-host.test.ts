import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PAGES_DEFAULT_CACHE, headersFor, parseHeadersFile, startPagesHost, type PagesHost } from './support/pages-host'

/**
 * THE STAND-IN FOR THE CONSOLE'S STATIC HOST (support/pages-host.ts) does what
 * the real host does with a directory, since the console's acceptance loads
 * the page from it: a wrong stand-in would accept a build the host breaks.
 */

const HEADERS = ['# a comment', '/*', '  X-Content-Type-Options: nosniff', '  Vary: one', '', '/assets/*', '  Cache-Control: public, max-age=31536000, immutable', '  Vary: two', '', '/sw.js', '  Cache-Control: no-cache', ''].join('\n')

let dir = ''
let next = ''
let host: PagesHost
const at = (pathname: string): Promise<Response> => fetch(`http://127.0.0.1:${host.port}${pathname}`)

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'pages-host-'))
  next = mkdtempSync(path.join(tmpdir(), 'pages-host-next-'))
  mkdirSync(path.join(dir, 'assets'))
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>the page</title>')
  writeFileSync(path.join(dir, 'assets', 'app-1.js'), 'export {}')
  writeFileSync(path.join(dir, 'sw.js'), '// worker')
  writeFileSync(path.join(dir, '_headers'), HEADERS)
  writeFileSync(path.join(next, 'index.html'), '<!doctype html><title>the next page</title>')
  host = await startPagesHost(dir)
})

afterAll(async () => {
  await host.close()
  rmSync(dir, { recursive: true, force: true })
  rmSync(next, { recursive: true, force: true })
})

describe('the headers file', () => {
  it('is blocks of a pattern and its headers; a header two matching blocks set is joined with a comma', () => {
    const blocks = parseHeadersFile(HEADERS)
    expect(blocks.map((block) => block.pattern)).toEqual(['/*', '/assets/*', '/sw.js'])
    expect(headersFor(blocks, '/assets/app-1.js')).toEqual({ 'x-content-type-options': 'nosniff', vary: 'one, two', 'cache-control': 'public, max-age=31536000, immutable' })
    expect(headersFor(blocks, '/d/some-machine')).toEqual({ 'x-content-type-options': 'nosniff', vary: 'one' })
  })
})

describe('the host', () => {
  it('serves a file as that file, with the headers of every block that matches it', async () => {
    const asset = await at('/assets/app-1.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript')
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(asset.headers.get('vary')).toBe('one, two')
    expect((await at('/sw.js')).headers.get('cache-control')).toBe('no-cache')
  })

  it('answers every address that is no file with the page, status 200, asked for again every time', async () => {
    for (const pathname of ['/', '/d/0189d0f2-9a4c-8f31-9c0e-2b7a5d6e1f40/w/w1', '/auth/complete?code=x']) {
      const answer = await at(pathname)
      expect(answer.status, pathname).toBe(200)
      expect(await answer.text(), pathname).toContain('the page')
      expect(answer.headers.get('cache-control'), pathname).toBe(PAGES_DEFAULT_CACHE)
      expect(answer.headers.get('x-content-type-options'), pathname).toBe('nosniff')
    }
  })

  it('matches headers by the address, not by what it found there: a chunk that is gone is the page, served as a chunk is', async () => {
    // Why the console's worker refuses a page where it asked for a file (scripts/console-sw.mjs).
    const gone = await at('/assets/gone-9.js')
    expect(gone.status).toBe(200)
    expect(gone.headers.get('content-type')).toContain('text/html')
    expect(gone.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('never serves its own files, and nothing outside the directory', async () => {
    expect(await (await at('/_headers')).text()).toContain('the page')
    expect(await (await at('/..%2f..%2fetc/passwd')).text()).toContain('the page')
  })

  it('can be taken off the network and put back on the same port, and handed another directory', async () => {
    await host.stop()
    await expect(at('/')).rejects.toThrow()
    await host.start()
    expect((await at('/')).status).toBe(200)
    host.deploy(next)
    const page = await at('/assets/app-1.js')
    // The next directory has no such file and no headers file: the page, with the host's default only.
    expect(await page.text()).toContain('the next page')
    expect(page.headers.get('x-content-type-options')).toBeNull()
    host.deploy(dir)
  })
})
