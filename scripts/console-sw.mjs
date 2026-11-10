/**
 * THE CONSOLE'S SERVICE WORKER, written at build time (vite.console.config.ts).
 *
 * ONE VERSION, ONE CACHE, EVERYTHING IN IT. At install it takes the page and
 * every file the build emitted; from then on the page and its files come from
 * that cache. A page that is open keeps the worker it was opened with, and so
 * always finds the chunks its own build named, whatever has been deployed
 * since. A new build is a new worker with a new cache (the build names it by
 * a digest of its own files, so two builds never share one): the browser
 * installs it beside the old one and it takes over when the old page is gone,
 * or when a page's person presses for the new build.
 *
 * THE BUILD BEFORE IT IS KEPT, ONE BACK. When a worker takes over because one
 * tab pressed, another tab may still be running the old build, and the parts
 * that tab has not loaded yet are only in the old cache. So a taking-over
 * worker keeps that one cache and answers its files to whoever asks. A file of
 * no build it knows is asked of the host past every cache, and if the host
 * answers with the page (as a static host does for an address that is no
 * file) that is refused as a 404: a page run as a script is an error nobody
 * can read, and kept by the browser it would outlive the next deploy.
 *
 * IT NEVER TOUCHES AN API ANSWER. It answers GETs of this origin's own files
 * and nothing else: a request to the registry or to a machine is another
 * origin and is not even looked at.
 *
 * THE WAY OUT (`consoleWorkerKillSwitch`): a worker that deletes every cache
 * and unregisters itself. sw.js is served `no-cache`, so deploying that file
 * reaches every browser the next time it opens the page.
 */

/** @param {{ version: string, assets: readonly string[] }} input */
export function consoleWorkerSource({ version, assets }) {
  const files = [...new Set(assets)].filter((path) => path.startsWith('/') && path !== '/sw.js').sort()
  return `/* Cookrew console service worker ${version}. Generated: do not edit. */
const PREFIX = 'cookrew-console-'
const CACHE = ${JSON.stringify(`cookrew-console-${version}`)}
// The page, by the address a static host serves it at without a redirect: an answer that came by
// way of a redirect ("/index.html" to "/") is refused for a navigation, and would break every load.
const SHELL = '/'
const FILES = ${JSON.stringify(files)}
const HELD = new Set(FILES)

self.addEventListener('install', (event) => {
  // Past the browser's own HTTP cache: a stale copy must not be what a new version keeps.
  const fresh = [SHELL, ...FILES].map((path) => new Request(new URL(path, self.location.origin), { cache: 'reload' }))
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(fresh)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        // In the order they were made: the last console cache that is not this one is the build before it.
        const before = keys.filter((key) => key.startsWith(PREFIX) && key !== CACHE).slice(-1)
        const kept = new Set([CACHE, ...before])
        return Promise.all(keys.filter((key) => !kept.has(key)).map((key) => caches.delete(key)))
      })
      .then(() => self.clients.claim())
  )
})

// A newer worker waits beside the old one. It comes in early only when the page asks, which the page does
// only when its person pressed for the new build (console/console-version.ts).
self.addEventListener('message', (event) => {
  if (event.data === 'take-over') self.skipWaiting()
})

const isPage = (answer) => (answer.headers.get('content-type') || '').includes('text/html')
const ofAnotherBuild = (key, request) =>
  caches
    .match(key)
    .then((hit) => hit || fetch(request, { cache: 'no-store' }).then((answer) => (isPage(answer) ? new Response('', { status: 404 }) : answer)))

const held = (key, request) => caches.open(CACHE).then((cache) => cache.match(key)).then((hit) => hit || fetch(request))

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate') return event.respondWith(held(SHELL, request))
  if (HELD.has(url.pathname)) return event.respondWith(held(url.pathname, request))
  if (url.pathname.startsWith('/assets/')) event.respondWith(ofAnotherBuild(url.pathname, request))
})
`
}

/** The worker that ends workers: every cache deleted, itself unregistered. A page already open goes to the network from its next load. */
export function consoleWorkerKillSwitch() {
  return `/* Cookrew console service worker: the way out. */
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.registration.unregister())
  )
})
`
}
