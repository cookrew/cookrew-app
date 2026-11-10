/**
 * THE CONSOLE'S BUILD (0.6.0): console.cookrew.dev as static files.
 *
 * The same renderer sources as the app, entered at src/renderer/console.html,
 * written to out/console: one index.html, hashed assets, sw.js and
 * version.json. Nothing here deploys anything; CI uploads the directory.
 *
 *   COOKREW_API_ORIGIN, COOKREW_AUTH_ORIGIN   the registry's two hosts, written
 *                                             into the page (defaults: production)
 *   COOKREW_CONSOLE_VERSION                   names the worker's cache
 *                                             (default: the package version)
 */
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { consoleWorkerSource } from './scripts/console-sw.mjs'

const root = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }

const origins = {
  COOKREW_API_ORIGIN: process.env.COOKREW_API_ORIGIN ?? 'https://api.cookrew.dev',
  COOKREW_AUTH_ORIGIN: process.env.COOKREW_AUTH_ORIGIN ?? 'https://auth.cookrew.dev'
}
const version = process.env.COOKREW_CONSOLE_VERSION ?? pkg.version
const publicDir = path.join(root, 'src/renderer/public')

/** The page as a static host serves it: index.html, with the hosts written in, a worker and a version beside it. */
function consolePage(): Plugin {
  return {
    name: 'cookrew-console-page',
    // After Vite's own plugins: the page and every asset they emit are in the bundle by then.
    enforce: 'post',
    transformIndexHtml: (html) => html.replace(/%(COOKREW_API_ORIGIN|COOKREW_AUTH_ORIGIN)%/g, (_, name: keyof typeof origins) => origins[name]),
    generateBundle(_options, bundle) {
      const page = bundle['console.html']
      if (page) page.fileName = 'index.html'
      const built = Object.values(bundle).map((file) => `/${file.fileName}`)
      // Copied as they are, outside the bundle: the icons and the manifest.
      const copied = readdirSync(publicDir).map((file) => `/${file}`)
      const assets = [...built, ...copied].filter((file) => file !== '/index.html' && !file.endsWith('.map'))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: consoleWorkerSource({ version, assets }) })
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ version })}\n` })
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
