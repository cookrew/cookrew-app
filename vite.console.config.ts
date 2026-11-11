/**
 * THE CONSOLE'S BUILD (0.6.0): console.cookrew.dev as static files.
 *
 * The same renderer sources as the app, entered at src/renderer/console.html,
 * written to out/console: one index.html, hashed assets, sw.js and
 * version.json. Nothing here deploys anything; CI uploads the directory.
 *
 *   COOKREW_API_ORIGIN, COOKREW_AUTH_ORIGIN   the registry's two hosts, written
 *                                             into the page (defaults: production)
 *   COOKREW_CONSOLE_LOCAL=1                   allows loopback http hosts (a local registry)
 *   COOKREW_CONSOLE_VERSION                   the version it says it is
 *                                             (default: the package version)
 */
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { consoleWorkerSource } from './scripts/console-sw.mjs'
import { consoleHeaders, withIntegrity } from './scripts/console-host-files.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }

/**
 * A registry host as the page may be built with it: a bare https origin. A
 * loopback http one is for a local registry in a test and has to be asked for
 * (COOKREW_CONSOLE_LOCAL=1), so a developer's environment cannot ship by
 * accident. Anything else stops the build.
 */
function originFor(name: string, fallback: string): string {
  const raw = process.env[name] || fallback
  const url = new URL(raw)
  const bare = url.origin === raw.replace(/\/$/, '') && url.username === '' && url.password === ''
  const local = process.env.COOKREW_CONSOLE_LOCAL === '1' && url.protocol === 'http:' && /^(localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1)$/.test(url.hostname)
  if (!bare || (url.protocol !== 'https:' && !local)) throw new Error(`${name} must be a bare https origin (got ${JSON.stringify(raw)})`)
  return url.origin
}

const origins = {
  COOKREW_API_ORIGIN: originFor('COOKREW_API_ORIGIN', 'https://api.cookrew.dev'),
  COOKREW_AUTH_ORIGIN: originFor('COOKREW_AUTH_ORIGIN', 'https://auth.cookrew.dev')
}
const version = process.env.COOKREW_CONSOLE_VERSION ?? pkg.version
const publicDir = path.join(root, 'src/renderer/public')

/** The page as a static host serves it: index.html, with the hosts written in, a worker and a version beside it. */
function consolePage(): Plugin {
  return {
    name: 'cookrew-console-page',
    // After Vite's own plugins: the page and every asset they emit are in the bundle by then.
    enforce: 'post',
    transformIndexHtml: (html) => ({
      html: html.replace(/%(COOKREW_API_ORIGIN|COOKREW_AUTH_ORIGIN)%/g, (_, name: keyof typeof origins) => origins[name]),
      // THE CONNECTION TO THE API HOST, opened while the scripts load (latency 0.6.1): a new one
      // took ~1.5 s from the owner's Mac. `crossorigin` sends no credentials, which is the pool
      // every call of the console uses (credentials: 'omit'). Written here, not in the page: a
      // placeholder in an href is not a URL Vite's own HTML step can read.
      tags: [{ tag: 'link', attrs: { rel: 'preconnect', href: origins.COOKREW_API_ORIGIN, crossorigin: '' }, injectTo: 'head' }]
    }),
    generateBundle(_options, bundle) {
      const page = bundle['console.html']
      if (page) page.fileName = 'index.html'
      const built = Object.values(bundle).map((file) => `/${file.fileName}`)
      // Copied as they are, outside the bundle: the icons and the manifest.
      const copied = readdirSync(publicDir).map((file) => `/${file}`)
      const assets = [...built, ...copied].filter((file) => file !== '/index.html' && !file.endsWith('.map'))
      // The cache is named by what is in it: file names carry their content's hash, and the page
      // itself is hashed in, so two builds that differ at all never share a cache.
      const pageSource = page && 'source' in page ? String(page.source) : ''
      const build = createHash('sha256').update([...assets].sort().join('\n')).update(pageSource).digest('hex').slice(0, 12)
      // The page says which build it is, so it can tell when the host serves another (console/console-version.ts).
      if (page && 'source' in page) page.source = pageSource.replace('</head>', `  <meta name="cookrew-build" content="${build}" />\n  </head>`)
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: consoleWorkerSource({ version: `${version}-${build}`, assets }) })
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ version, build })}\n` })
      // What the host serves each answer with (scripts/console-host-files.mjs). Not a file of the page: the worker never holds it.
      this.emitFile({ type: 'asset', fileName: '_headers', source: consoleHeaders({ api: origins.COOKREW_API_ORIGIN, local: process.env.COOKREW_CONSOLE_LOCAL === '1' }) })
    },
    // AFTER the files are on disk, from the bytes that were written: other plugins may still touch a chunk
    // after generateBundle, and a pin over anything but the final bytes would refuse the page its own script.
    writeBundle(options) {
      const dir = options.dir
      if (!dir) return
      const file = path.join(dir, 'index.html')
      const read = (name: string): Uint8Array | null => {
        try {
          return readFileSync(path.join(dir, name))
        } catch {
          return null
        }
      }
      writeFileSync(file, withIntegrity(readFileSync(file, 'utf8'), read))
    }
  }
}

export default defineConfig({
  root: path.join(root, 'src/renderer'),
  // Set only by this build: the page registers its worker when it is there (console/register-worker.ts).
  define: { __COOKREW_CONSOLE_BUILD__: 'true' },
  plugins: [react(), consolePage()],
  build: {
    outDir: path.join(root, 'out/console'),
    emptyOutDir: true,
    // Nothing is inlined as a data: URL: the page's policy takes fonts and images from this origin's files only.
    assetsInlineLimit: 0,
    rollupOptions: { input: path.join(root, 'src/renderer/console.html') }
  }
})
