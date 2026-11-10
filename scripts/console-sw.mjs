/**
 * THE CONSOLE'S SERVICE WORKER, written at build time (vite.console.config.ts).
 *
 * ONE VERSION, ONE CACHE, EVERYTHING IN IT. At install it takes the page and
 * every file the build emitted; from then on the page and its files come from
 * that cache. A page that is open keeps the worker it was opened with, and so
 * always finds the chunks its own build named, whatever has been deployed
 * since. A new build is a new worker with a new cache: the browser installs
 * it beside the old one and it takes over when the old page is gone, never
 * under a finger.
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
const CACHE = ${JSON.stringify(`cookrew-console-${version}`)}
const SHELL = '/index.html'
const FILES = ${JSON.stringify(files)}
const HELD = new Set(FILES)

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([SHELL, ...FILES])))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  )
})

const held = (key, request) => caches.open(CACHE).then((cache) => cache.match(key)).then((hit) => hit || fetch(request))

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate') return event.respondWith(held(SHELL, request))
  if (HELD.has(url.pathname)) event.respondWith(held(url.pathname, request))
})
`
}

/** The worker that ends workers: every cache deleted, itself unregistered, open pages reloaded onto the network. */
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
