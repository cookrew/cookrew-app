import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { consoleHeaders, consolePolicy, firstLoad, fontsNamed, withIntegrity } from '../scripts/console-host-files.mjs'

/**
 * WHAT THE CONSOLE'S STATIC HOST IS TOLD, AND WHAT THE PAGE PINS
 * (scripts/console-host-files.mjs, written into out/console by the build).
 * `_headers` carries the policy the page runs under and how long each file is
 * kept; the page names its first scripts and styles with their digest, so a
 * file swapped on its own is not run.
 */

const API = 'https://api.cookrew.dev'
const blocks = (headers: string): Map<string, string[]> => {
  const out = new Map<string, string[]>()
  let at = ''
  for (const line of headers.split('\n')) {
    if (line.startsWith('#') || line.trim() === '') continue
    if (!/^\s/.test(line)) out.set((at = line.trim()), [])
    else out.get(at)?.push(line.trim())
  }
  return out
}

describe('the policy the console runs under', () => {
  const policy = consolePolicy({ api: API })
  const directive = (name: string): string => policy.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? ''

  it('lets the terminal draw: it writes styles of its own, and a silent sound unlocks speech on a phone', () => {
    // xterm's DOM renderer (the one a page in a browser gets) adds <style> elements and style
    // attributes for colours, the cursor and cell sizes, and the phone's live history writes
    // coloured spans. Without this the terminal is one colour with no cursor.
    expect(directive('style-src')).toBe("style-src 'self' 'unsafe-inline'")
    // The reply voice is unlocked by playing a data: clip (prompt/reply-voice.ts).
    expect(directive('media-src')).toBe("media-src 'self' blob: data:")
    // What an injected style could send out stays shut: pictures and fonts from here only.
    expect(directive('img-src')).toBe("img-src 'self' data: blob:")
    expect(directive('font-src')).toBe("font-src 'self'")
  })

  it('runs only its own scripts, and nothing inline', () => {
    expect(directive('default-src')).toBe("default-src 'none'")
    expect(directive('script-src')).toBe("script-src 'self'")
    expect(policy).not.toContain('unsafe-eval')
    expect(directive('script-src')).not.toContain('unsafe-inline')
  })

  it('talks to itself, the API host, and a machine’s own name on its own port, and to nobody else', () => {
    // 'self': the worker's install and the version check are fetches of this origin.
    expect(directive('connect-src')).toBe(`connect-src 'self' ${API} https://*.d.cookrew.dev:8643 wss://*.d.cookrew.dev:8643`)
  })

  it('cannot be framed, rebased or made to post a form', () => {
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'")
    expect(directive('base-uri')).toBe("base-uri 'none'")
    expect(directive('form-action')).toBe("form-action 'none'")
  })

  it('is built for an API host that is a bare origin, https unless a local one is asked for', () => {
    for (const bad of ['https://api.cookrew.dev/x', 'javascript:alert(1)', 'http://api.cookrew.dev', "https://a'b.example", 'https://api.cookrew.dev; script-src *']) expect(() => consolePolicy({ api: bad }), bad).toThrow()
    expect(() => consolePolicy({ api: 'http://api.localhost:8792' })).toThrow()
    expect(consolePolicy({ api: 'http://api.localhost:8792', local: true })).toContain('http://api.localhost:8792')
  })
})

describe('_headers', () => {
  const headers = consoleHeaders({ api: API })
  const read = blocks(headers)

  it('puts the policy and the hardening on every address', () => {
    const all = read.get('/*') ?? []
    expect(all).toContain(`Content-Security-Policy: ${consolePolicy({ api: API })}`)
    expect(all).toContain('X-Content-Type-Options: nosniff')
    expect(all).toContain('Referrer-Policy: no-referrer')
    // No other site's window keeps a handle on this one; sign-in leaves and comes back by navigation.
    expect(all).toContain('Cross-Origin-Opener-Policy: same-origin')
    // The microphone is the phone's ear; nothing here uses a camera, a location or a payment.
    expect(all).toContain('Permissions-Policy: camera=(), geolocation=(), payment=(), usb=(), microphone=(self), fullscreen=(self), clipboard-write=(self)')
  })

  it('keeps hashed files for a year and asks again for the worker and the version, every time', () => {
    expect(read.get('/assets/*')).toEqual(['Cache-Control: public, max-age=31536000, immutable'])
    expect(read.get('/sw.js')).toEqual(['Cache-Control: no-cache'])
    expect(read.get('/version.json')).toEqual(['Cache-Control: no-cache'])
  })

  it('sets no header in two blocks that can match one address: the host would join them with a comma', () => {
    expect((read.get('/*') ?? []).some((line) => line.startsWith('Cache-Control'))).toBe(false)
    const cached = [...read].filter(([, lines]) => lines.some((line) => line.startsWith('Cache-Control'))).map(([pattern]) => pattern)
    expect(cached.sort()).toEqual(['/assets/*', '/sw.js', '/version.json'])
    for (const line of headers.split('\n')) expect(line.length).toBeLessThan(2000)
  })
})

describe('the page pins the files it starts with', () => {
  const files: Record<string, string> = { '/assets/console-AAAA.js': 'console.log(1)', '/assets/console-BBBB.css': 'body{}', '/assets/vendor-CCCC.js': 'export {}' }
  const read = (path: string): Uint8Array | null => (path in files ? Buffer.from(files[path]) : null)
  const digest = (path: string): string => `sha384-${createHash('sha384').update(files[path]).digest('base64')}`
  const html = `<!doctype html><html><head><link rel="icon" href="/favicon.svg"><link rel="manifest" href="/manifest.webmanifest">
<script type="module" crossorigin src="/assets/console-AAAA.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-CCCC.js">
<link rel="stylesheet" crossorigin href="/assets/console-BBBB.css"></head><body></body></html>`

  it('every script and style it loads at once carries the digest of its bytes', () => {
    const pinned = withIntegrity(html, read)
    for (const path of Object.keys(files)) expect(pinned, path).toMatch(new RegExp(`(?:src|href)="${path.replace(/[.]/g, '\\.')}"[^>]*integrity="${digest(path).replace(/[+/=]/g, '\\$&')}"`))
    expect(pinned.match(/integrity=/g)).toHaveLength(3)
    // Icons and the manifest are not code: left as they are.
    expect(pinned).toContain('<link rel="icon" href="/favicon.svg">')
  })

  it('pinning twice changes nothing, and a file the page names that the build did not write stops the build', () => {
    const once = withIntegrity(html, read)
    expect(withIntegrity(once, read)).toBe(once)
    expect(() => withIntegrity(html, () => null)).toThrow(/console-AAAA\.js|vendor-CCCC\.js|console-BBBB\.css/)
  })

  it('names what the first load is: the page’s own scripts, preloads and styles', () => {
    expect(firstLoad(html).sort()).toEqual(Object.keys(files).sort())
  })

  it('and the fonts its first styles name: they are fetched before the first words are drawn', () => {
    const css = '@font-face{src:url(/assets/inter-AAAA.woff2) format("woff2")}@font-face{src:url("/assets/mono-BBBB.woff2")}.x{background:url(/assets/pic-CCCC.png)}'
    expect(fontsNamed(css).sort()).toEqual(['/assets/inter-AAAA.woff2', '/assets/mono-BBBB.woff2'])
  })
})
