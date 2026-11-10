// WHAT THE CONSOLE'S STATIC HOST IS TOLD, AND WHAT THE PAGE PINS.
//
// The console is static files on a host that reads two things from them: every
// address without a file is answered with the page (so there is no 404.html),
// and `_headers` says what each answer is served with. This writes `_headers`,
// and pins the page's first scripts and styles to the bytes that were built.
// Pure: the build (vite.console.config.ts) and the size gate (console-size.mjs)
// hand it what they read.
//
// THE POLICY. Only this origin's own scripts run, nothing inline. The page
// talks to itself (its worker's install, its version file), to the API host it
// was built for, and to a machine's own name on the machine's port: the direct
// path, by https and by WebSocket. It cannot be framed, rebased or made to post
// a form.
//
// STYLES MAY BE WRITTEN IN PLACE ('unsafe-inline'), because the terminal does:
// a page in a browser gets xterm's DOM renderer, which adds <style> elements
// and style attributes for colours, the cursor and cell sizes, and the phone's
// live history writes coloured spans. Without it the terminal is one colour
// with no cursor. What an injected style could do with that is kept small by
// the rest: pictures and fonts come from this origin only, and nothing but the
// named hosts can be reached. Sound may be a data: clip: a silent one unlocks
// the reply voice on a phone.
//
// THE HOST JOINS A HEADER TWO MATCHING BLOCKS SET, with a comma (Cloudflare
// Pages; read 2026-11-11). So Cache-Control is set only in blocks that cannot
// match the same address, and never under `/*`: the page keeps the host's
// default, which is to ask again every time.
//
// WHAT THE PINS ARE WORTH. A file swapped on its own, or a poisoned cache, is
// not run. A host taken over whole serves its own page with its own pins:
// nothing here stops that. Chunks loaded later are not pinned yet.
import { createHash } from 'node:crypto'

const MACHINE_NAMES = ['https://*.d.cookrew.dev:8643', 'wss://*.d.cookrew.dev:8643']
export const CONSOLE_HOST_MARK = '# console.cookrew.dev, built by scripts/console-host-files.mjs.'

/** A bare https origin, spelled out; a loopback http one only when a local build asks. Goes into a header: nothing else may. */
function apiOrigin(raw, local) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`the API host is not an origin: ${JSON.stringify(raw)}`)
  }
  const bare = url.origin === String(raw).replace(/\/$/, '') && url.username === '' && url.password === '' && /^[a-z0-9.-]+(:\d+)?$/.test(url.host)
  const loopback = local === true && url.protocol === 'http:' && /^(localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1)$/.test(url.hostname)
  if (!bare || (url.protocol !== 'https:' && !loopback)) throw new Error(`the API host must be a bare https origin: ${JSON.stringify(raw)}`)
  return url.origin
}

/** @param {{ api: string, local?: boolean }} input */
export function consolePolicy({ api, local = false }) {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src 'self' ${apiOrigin(api, local)} ${MACHINE_NAMES.join(' ')}`,
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "font-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ')
}

/** @param {{ api: string, local?: boolean }} input */
export function consoleHeaders(input) {
  return [
    CONSOLE_HOST_MARK,
    '# Cache-Control is never set under /*: the host joins a header two matching blocks set.',
    '/*',
    `  Content-Security-Policy: ${consolePolicy(input)}`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    // No other site's window keeps a handle on this one. Sign-in leaves and comes back by navigation.
    '  Cross-Origin-Opener-Policy: same-origin',
    // The microphone is the phone's ear. Nothing here uses the rest.
    '  Permissions-Policy: camera=(), geolocation=(), payment=(), usb=(), microphone=(self), fullscreen=(self), clipboard-write=(self)',
    '',
    '# Named by their content: kept.',
    '/assets/*',
    '  Cache-Control: public, max-age=31536000, immutable',
    '',
    '# The worker and the version are how a new build is found: asked for every time.',
    '/sw.js',
    '  Cache-Control: no-cache',
    '',
    '/version.json',
    '  Cache-Control: no-cache',
    ''
  ].join('\n')
}

const TAG = /<(script|link)\b[^>]*>/g
const NAMED = /\s(?:src|href)="(\/assets\/[^"?#]+\.(?:js|css))"/
const STARTS = /\srel="(?:stylesheet|modulepreload)"/

/** The file a tag loads at once, or null: a script with a src, a stylesheet, a module preload. */
function loadedBy(tag, kind) {
  const named = NAMED.exec(tag)
  if (named === null) return null
  return kind === 'script' || STARTS.test(tag) ? named[1] : null
}

/** The page's own scripts, preloads and styles: what a first visit downloads before it paints. */
export function firstLoad(html) {
  return [...html.matchAll(TAG)].map(([tag, kind]) => loadedBy(tag, kind)).filter((path) => path !== null)
}

/** The fonts a stylesheet names under /assets/: fetched before the first words are drawn. */
export function fontsNamed(css) {
  return [...new Set([...css.matchAll(/url\(["']?(\/assets\/[^"')?#]+\.woff2)/g)].map(([, path]) => path))]
}

/**
 * The page with each of those pinned to its bytes. `read` answers a path's
 * bytes or null; a file the page names that was not built stops the build.
 * @param {string} html
 * @param {(path: string) => Uint8Array | null} read
 */
export function withIntegrity(html, read) {
  return html.replace(TAG, (tag, kind) => {
    const path = loadedBy(tag, kind)
    if (path === null || /\sintegrity=/.test(tag)) return tag
    const bytes = read(path)
    if (bytes === null) throw new Error(`the page names ${path}, and the build did not write it`)
    const digest = createHash('sha384').update(bytes).digest('base64')
    const anonymous = /\scrossorigin\b/.test(tag) ? '' : ' crossorigin'
    return `${tag.slice(0, -1)}${anonymous} integrity="sha384-${digest}">`
  })
}
